-- =====================================================================
-- 002 : Portail client + mini-CRM (entreprises, échéances, documents)
-- Idempotent : peut être rejoué sans erreur.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Rôle applicatif SANS bypass RLS.
-- L'API fait `SET LOCAL ROLE cpaie_app` dans chaque transaction, ce qui
-- force l'application des politiques RLS même si l'utilisateur de
-- connexion (propriétaire / Neon / Supabase) possède BYPASSRLS.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cpaie_app') THEN
    CREATE ROLE cpaie_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT cpaie_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'GRANT cpaie_app TO current_user ignoré : %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------
-- Fonctions d'identité (lues depuis les variables de transaction posées
-- par l'API après vérification du JWT Auth0).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.role', true), '') = 'Admin'
$$;

-- ---------------------------------------------------------------------
-- Entreprises clientes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  siret         VARCHAR(20),
  ccn           VARCHAR(255),              -- convention collective
  headcount     INT CHECK (headcount IS NULL OR headcount >= 0),
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('prospect','active','archived')),
  notes         TEXT,                       -- notes internes (admin uniquement côté API)
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Rattachement utilisateur <-> entreprise
CREATE TABLE IF NOT EXISTS company_members (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members(user_id);

-- Interlocuteurs de l'entreprise (CRM)
CREATE TABLE IF NOT EXISTS company_contacts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name   VARCHAR(255) NOT NULL,
  job_title   VARCHAR(255),
  email       VARCHAR(255),
  phone       VARCHAR(50),
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_company_contacts_company ON company_contacts(company_id);

-- Invitations : l'inscription libre est interdite. Un utilisateur Auth0
-- n'obtient un accès que si son e-mail figure ici (ou s'il existe déjà).
CREATE TABLE IF NOT EXISTS invitations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       VARCHAR(255) NOT NULL,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL DEFAULT 'Client' CHECK (role IN ('Client','Admin')),
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_email ON invitations (lower(email));

-- ---------------------------------------------------------------------
-- Calendrier de paie
-- ---------------------------------------------------------------------
-- Paramètres par entreprise : jour du mois de chaque étape.
CREATE TABLE IF NOT EXISTS company_calendar_settings (
  company_id     UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  variables_day  INT NOT NULL DEFAULT 20 CHECK (variables_day BETWEEN 1 AND 31),
  validation_day INT NOT NULL DEFAULT 25 CHECK (validation_day BETWEEN 1 AND 31),
  payment_day    INT NOT NULL DEFAULT 28 CHECK (payment_day BETWEEN 1 AND 31),
  social_day     INT NOT NULL DEFAULT 15 CHECK (social_day BETWEEN 1 AND 31),
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deadlines (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL
              CHECK (kind IN ('variables','validation','payment','social','other')),
  title       VARCHAR(255) NOT NULL,
  due_date    DATE NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo','in_progress','done')),
  notes       TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_deadlines_company_due ON deadlines(company_id, due_date);
-- Évite les doublons lors de la génération automatique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deadlines_generated
  ON deadlines(company_id, kind, due_date) WHERE kind <> 'other';

-- ---------------------------------------------------------------------
-- Documents
--   company_id NULL  => bibliothèque de modèles (visible par tous les
--                       clients connectés quand published = true)
--   company_id = X   => document propre à l'entreprise X
-- Le binaire est stocké dans une table séparée : jamais exposé par une
-- URL publique, uniquement via l'endpoint de téléchargement authentifié.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  category    VARCHAR(100),
  file_name   VARCHAR(255) NOT NULL,
  mime_type   VARCHAR(150) NOT NULL,
  size_bytes  INT NOT NULL CHECK (size_bytes > 0),
  published   BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_files (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  data        BYTEA NOT NULL
);

-- ---------------------------------------------------------------------
-- Demandes de contact : rattachement optionnel à une entreprise + source
-- ---------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'portal';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS admin_notes TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- ---------------------------------------------------------------------
-- Triggers updated_at
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','company_contacts','company_calendar_settings','deadlines','documents']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
ALTER TABLE companies                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE company_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members           FORCE  ROW LEVEL SECURITY;
ALTER TABLE company_contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_contacts          FORCE  ROW LEVEL SECURITY;
ALTER TABLE company_calendar_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_calendar_settings FORCE  ROW LEVEL SECURITY;
ALTER TABLE deadlines                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadlines                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE documents                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE document_files            ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_files            FORCE  ROW LEVEL SECURITY;
ALTER TABLE invitations               ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations               FORCE  ROW LEVEL SECURITY;
ALTER TABLE contacts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts                  FORCE  ROW LEVEL SECURITY;

-- Helper : l'utilisateur courant appartient-il à cette entreprise ?
-- SECURITY DEFINER pour éviter la récursion de politiques sur company_members.
CREATE OR REPLACE FUNCTION app_is_member(cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members m
    WHERE m.company_id = cid AND m.user_id = app_user_id()
  )
$$;
REVOKE ALL ON FUNCTION app_is_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_member(uuid), app_user_id(), app_is_admin() TO cpaie_app;

DO $$
DECLARE t text;
BEGIN
  -- Nettoyage pour rendre le script rejouable
  FOR t IN SELECT format('%I ON %I', policyname, tablename) FROM pg_policies
           WHERE schemaname = 'public' AND policyname LIKE 'p\_%' ESCAPE '\'
  LOOP
    EXECUTE 'DROP POLICY ' || t;
  END LOOP;
END $$;

-- Admin : accès total partout
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','company_members','company_contacts','company_calendar_settings',
                           'deadlines','documents','document_files','invitations','contacts']
  LOOP
    EXECUTE format('CREATE POLICY p_admin_all ON %I FOR ALL TO cpaie_app
                    USING (app_is_admin()) WITH CHECK (app_is_admin())', t);
  END LOOP;
END $$;

-- Clients : lecture limitée à leurs entreprises
CREATE POLICY p_member_select ON companies FOR SELECT TO cpaie_app
  USING (app_is_member(id));
CREATE POLICY p_member_select ON company_members FOR SELECT TO cpaie_app
  USING (user_id = app_user_id());
CREATE POLICY p_member_select ON company_contacts FOR SELECT TO cpaie_app
  USING (app_is_member(company_id));
CREATE POLICY p_member_select ON company_calendar_settings FOR SELECT TO cpaie_app
  USING (app_is_member(company_id));
CREATE POLICY p_member_select ON deadlines FOR SELECT TO cpaie_app
  USING (app_is_member(company_id));
-- Un client peut faire avancer le statut d'une échéance de son entreprise
-- (ex. « variables transmises »). L'API restreint la colonne modifiable.
CREATE POLICY p_member_update ON deadlines FOR UPDATE TO cpaie_app
  USING (app_is_member(company_id)) WITH CHECK (app_is_member(company_id));

-- Documents : propres à l'entreprise (publiés) OU modèles de la bibliothèque (publiés)
CREATE POLICY p_member_select ON documents FOR SELECT TO cpaie_app
  USING (app_user_id() IS NOT NULL AND published AND (company_id IS NULL OR app_is_member(company_id)));
CREATE POLICY p_member_select ON document_files FOR SELECT TO cpaie_app
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_files.document_id
      AND app_user_id() IS NOT NULL
      AND d.published AND (d.company_id IS NULL OR app_is_member(d.company_id))
  ));

-- Contacts / demandes : un client ne voit que ses propres demandes
CREATE POLICY p_own_select ON contacts FOR SELECT TO cpaie_app
  USING (user_id = app_user_id());
CREATE POLICY p_own_insert ON contacts FOR INSERT TO cpaie_app
  WITH CHECK (user_id = app_user_id());
-- Formulaire public (sans compte) : insertion anonyme, source obligatoire
CREATE POLICY p_public_insert ON contacts FOR INSERT TO cpaie_app
  WITH CHECK (user_id IS NULL AND source = 'public_form' AND app_user_id() IS NULL);

-- Privilèges de table pour le rôle applicatif
GRANT SELECT, INSERT, UPDATE, DELETE ON
  companies, company_members, company_contacts, company_calendar_settings,
  deadlines, documents, document_files, invitations, contacts
TO cpaie_app;
-- Utilisateurs : lecture seule via le rôle applicatif. RLS activée (sans FORCE) :
-- le rôle propriétaire utilisé pour la synchronisation Auth0 n'est pas affecté,
-- le rôle cpaie_app ne voit que sa propre ligne (ou tout, pour un admin).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_users_select ON users;
CREATE POLICY p_users_select ON users FOR SELECT TO cpaie_app
  USING (app_is_admin() OR id = app_user_id());
GRANT SELECT ON users TO cpaie_app;
