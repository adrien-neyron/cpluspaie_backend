import type { PoolClient } from 'pg';
import { withScope } from './scope.service.js';
import { httpError, validateUpload } from './files.service.js';
import type { DBUser } from '../types/auth.types.js';
import type { Company, Deadline, DeadlineKind, DeadlineStatus, DocumentMeta } from '../types/portal.types.js';

type Actor = Pick<DBUser, 'id' | 'role'>;

const DOC_COLS = `d.id, d.company_id, d.title, d.description, d.category, d.file_name,
                  d.mime_type, d.size_bytes, d.published, d.created_at`;

/* ------------------------------------------------------------------ */
/*  Côté client : tout passe par withScope => RLS appliquée par la base */
/* ------------------------------------------------------------------ */
export const clientPortal = {
  async myCompanies(actor: Actor): Promise<Company[]> {
    return withScope(actor, async (db) => {
      // `notes` (internes) n'est jamais sélectionné pour un client.
      const { rows } = await db.query<Company>(
        `SELECT id, name, siret, ccn, headcount, status, created_at, updated_at
         FROM companies ORDER BY name`
      );
      return rows;
    });
  },

  async dashboard(actor: Actor) {
    return withScope(actor, async (db) => {
      const deadlines = (
        await db.query<Deadline>(
          `SELECT dl.id, dl.company_id, c.name AS company_name, dl.kind, dl.title,
                  to_char(dl.due_date,'YYYY-MM-DD') AS due_date, dl.status, dl.notes
           FROM deadlines dl JOIN companies c ON c.id = dl.company_id
           WHERE dl.status <> 'done' AND dl.due_date <= CURRENT_DATE + INTERVAL '45 days'
           ORDER BY dl.due_date ASC LIMIT 30`
        )
      ).rows;
      const recentDocuments = (
        await db.query<DocumentMeta>(
          `SELECT ${DOC_COLS} FROM documents d ORDER BY d.created_at DESC LIMIT 6`
        )
      ).rows;
      const today = new Date().toISOString().slice(0, 10);
      return {
        deadlines,
        recentDocuments,
        counts: {
          overdue: deadlines.filter((d) => d.due_date < today).length,
          upcoming: deadlines.filter((d) => d.due_date >= today).length,
        },
      };
    });
  },

  async listDeadlines(
    actor: Actor,
    f: { from?: string; to?: string; company_id?: string; status?: string }
  ): Promise<Deadline[]> {
    return withScope(actor, (db) => queryDeadlines(db, f));
  },

  /** Un client ne peut agir que sur les échéances « variables » (transmission). */
  async updateDeadlineStatus(actor: Actor, id: string, status: DeadlineStatus): Promise<Deadline | null> {
    return withScope(actor, async (db) => {
      const { rows } = await db.query<Deadline>(
        `UPDATE deadlines SET status = $2
         WHERE id = $1 AND kind = 'variables'
         RETURNING id, company_id, kind, title, to_char(due_date,'YYYY-MM-DD') AS due_date, status, notes`,
        [id, status]
      );
      return rows[0] ?? null;
    });
  },

  async listDocuments(
    actor: Actor,
    f: { search?: string; category?: string; scope?: 'library' | 'company'; company_id?: string }
  ): Promise<DocumentMeta[]> {
    return withScope(actor, (db) => queryDocuments(db, f));
  },

  async getDocumentFile(actor: Actor, id: string) {
    return withScope(actor, (db) => fetchFile(db, id));
  },
};

/* ------------------------------------------------------------------ */
/*  Côté admin (RLS : politique p_admin_all)                           */
/* ------------------------------------------------------------------ */
export const adminCrm = {
  /* ---- Entreprises ---- */
  async listCompanies(actor: Actor, f: { search?: string; status?: string }) {
    return withScope(actor, async (db) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (f.status) {
        params.push(f.status);
        where.push(`c.status = $${params.length}`);
      }
      if (f.search) {
        params.push(`%${f.search}%`);
        where.push(`(c.name ILIKE $${params.length} OR c.siret ILIKE $${params.length})`);
      }
      const { rows } = await db.query(
        `SELECT c.*,
           (SELECT COUNT(*)::int FROM company_members m WHERE m.company_id = c.id) AS members_count,
           (SELECT COUNT(*)::int FROM deadlines d WHERE d.company_id = c.id AND d.status <> 'done' AND d.due_date < CURRENT_DATE) AS overdue_count,
           (SELECT to_char(MIN(d.due_date),'YYYY-MM-DD') FROM deadlines d WHERE d.company_id = c.id AND d.status <> 'done' AND d.due_date >= CURRENT_DATE) AS next_due
         FROM companies c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY c.name`,
        params
      );
      return rows;
    });
  },

  async getCompany(actor: Actor, id: string) {
    return withScope(actor, async (db) => {
      const company = (await db.query('SELECT * FROM companies WHERE id = $1', [id])).rows[0];
      if (!company) return null;
      const members = await db.query(
        `SELECT u.id, u.email, u.name FROM company_members m JOIN users u ON u.id = m.user_id
         WHERE m.company_id = $1 ORDER BY u.email`, [id]);
      const contacts = await db.query('SELECT * FROM company_contacts WHERE company_id = $1 ORDER BY full_name', [id]);
      const settings = await db.query('SELECT * FROM company_calendar_settings WHERE company_id = $1', [id]);
      const invitations = await db.query(
        `SELECT id, email, role, accepted_at, created_at FROM invitations
         WHERE company_id = $1 ORDER BY created_at DESC`, [id]);
      return {
        ...company,
        members: members.rows,
        contacts: contacts.rows,
        calendar_settings: settings.rows[0] ?? null,
        invitations: invitations.rows,
      };
    });
  },

  async createCompany(actor: Actor, d: Partial<Company>) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO companies (name, siret, ccn, headcount, status, notes)
         VALUES ($1,$2,$3,$4,COALESCE($5,'active'),$6) RETURNING *`,
        [d.name, d.siret ?? null, d.ccn ?? null, d.headcount ?? null, d.status ?? null, d.notes ?? null]
      );
      await db.query('INSERT INTO company_calendar_settings (company_id) VALUES ($1)', [rows[0].id]);
      return rows[0];
    });
  },

  async updateCompany(actor: Actor, id: string, d: Partial<Company>) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `UPDATE companies SET
           name = COALESCE($2, name), siret = COALESCE($3, siret), ccn = COALESCE($4, ccn),
           headcount = COALESCE($5, headcount), status = COALESCE($6, status), notes = COALESCE($7, notes)
         WHERE id = $1 RETURNING *`,
        [id, d.name ?? null, d.siret ?? null, d.ccn ?? null, d.headcount ?? null, d.status ?? null, d.notes ?? null]
      );
      return rows[0] ?? null;
    });
  },

  async deleteCompany(actor: Actor, id: string) {
    return withScope(actor, async (db) => (await db.query('DELETE FROM companies WHERE id = $1', [id])).rowCount! > 0);
  },

  /* ---- Interlocuteurs ---- */
  async addContact(actor: Actor, companyId: string, d: { full_name: string; job_title?: string; email?: string; phone?: string }) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO company_contacts (company_id, full_name, job_title, email, phone)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [companyId, d.full_name, d.job_title ?? null, d.email ?? null, d.phone ?? null]
      );
      return rows[0];
    });
  },
  async updateContact(actor: Actor, id: string, d: Record<string, string | undefined>) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `UPDATE company_contacts SET full_name = COALESCE($2, full_name), job_title = COALESCE($3, job_title),
           email = COALESCE($4, email), phone = COALESCE($5, phone) WHERE id = $1 RETURNING *`,
        [id, d.full_name ?? null, d.job_title ?? null, d.email ?? null, d.phone ?? null]
      );
      return rows[0] ?? null;
    });
  },
  async deleteContact(actor: Actor, id: string) {
    return withScope(actor, async (db) => (await db.query('DELETE FROM company_contacts WHERE id = $1', [id])).rowCount! > 0);
  },

  /* ---- Membres & invitations ---- */
  async addMember(actor: Actor, companyId: string, userId: string) {
    return withScope(actor, async (db) => {
      await db.query(
        'INSERT INTO company_members (company_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [companyId, userId]);
    });
  },
  async removeMember(actor: Actor, companyId: string, userId: string) {
    return withScope(actor, async (db) => {
      await db.query('DELETE FROM company_members WHERE company_id = $1 AND user_id = $2', [companyId, userId]);
    });
  },
  async invite(actor: Actor, email: string, companyId: string | null) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO invitations (email, company_id, role, invited_by) VALUES ($1,$2,'Client',$3)
         ON CONFLICT (lower(email)) DO UPDATE SET company_id = EXCLUDED.company_id
         RETURNING *`,
        [email.trim(), companyId, actor.id]
      );
      return rows[0];
    });
  },
  async deleteInvitation(actor: Actor, id: string) {
    return withScope(actor, async (db) => (await db.query('DELETE FROM invitations WHERE id = $1', [id])).rowCount! > 0);
  },

  /* ---- Calendrier ---- */
  async saveCalendarSettings(
    actor: Actor, companyId: string,
    s: { variables_day: number; validation_day: number; payment_day: number; social_day: number }
  ) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO company_calendar_settings (company_id, variables_day, validation_day, payment_day, social_day)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id) DO UPDATE SET variables_day = EXCLUDED.variables_day,
           validation_day = EXCLUDED.validation_day, payment_day = EXCLUDED.payment_day, social_day = EXCLUDED.social_day
         RETURNING *`,
        [companyId, s.variables_day, s.validation_day, s.payment_day, s.social_day]
      );
      return rows[0];
    });
  },

  /** Génère les échéances mensuelles à partir des paramètres de l'entreprise. */
  async generateCalendar(actor: Actor, companyId: string, startMonth: string, months: number) {
    return withScope(actor, async (db) => {
      const s = (await db.query('SELECT * FROM company_calendar_settings WHERE company_id = $1', [companyId])).rows[0];
      if (!s) throw httpError(404, "Paramètres de calendrier introuvables pour cette entreprise.");
      const [y0, m0] = startMonth.split('-').map(Number);
      const plan: Array<[DeadlineKind, string, number]> = [
        ['social', 'Échéances sociales (DSN / URSSAF)', s.social_day],
        ['variables', 'Transmission des variables de paie', s.variables_day],
        ['validation', 'Validation des bulletins', s.validation_day],
        ['payment', 'Virement des salaires', s.payment_day],
      ];
      let created = 0;
      for (let i = 0; i < months; i++) {
        const first = new Date(Date.UTC(y0, m0 - 1 + i, 1));
        const y = first.getUTCFullYear();
        const m = first.getUTCMonth();
        const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const label = first.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        for (const [kind, title, day] of plan) {
          const due = new Date(Date.UTC(y, m, Math.min(day, lastDay)));
          const r = await db.query(
            `INSERT INTO deadlines (company_id, kind, title, due_date) VALUES ($1,$2,$3,$4)
             ON CONFLICT (company_id, kind, due_date) WHERE kind <> 'other' DO NOTHING`,
            [companyId, kind, `${title} — ${label}`, due.toISOString().slice(0, 10)]
          );
          created += r.rowCount ?? 0;
        }
      }
      return { created };
    });
  },

  async listDeadlines(actor: Actor, f: { from?: string; to?: string; company_id?: string; status?: string }) {
    return withScope(actor, (db) => queryDeadlines(db, f));
  },
  async createDeadline(actor: Actor, d: { company_id: string; kind: DeadlineKind; title: string; due_date: string; notes?: string }) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO deadlines (company_id, kind, title, due_date, notes) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, company_id, kind, title, to_char(due_date,'YYYY-MM-DD') AS due_date, status, notes`,
        [d.company_id, d.kind, d.title, d.due_date, d.notes ?? null]
      );
      return rows[0];
    });
  },
  async updateDeadline(actor: Actor, id: string, d: Partial<Deadline>) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `UPDATE deadlines SET title = COALESCE($2,title), due_date = COALESCE($3,due_date),
           status = COALESCE($4,status), notes = COALESCE($5,notes), kind = COALESCE($6,kind)
         WHERE id = $1
         RETURNING id, company_id, kind, title, to_char(due_date,'YYYY-MM-DD') AS due_date, status, notes`,
        [id, d.title ?? null, d.due_date ?? null, d.status ?? null, d.notes ?? null, d.kind ?? null]
      );
      return rows[0] ?? null;
    });
  },
  async deleteDeadline(actor: Actor, id: string) {
    return withScope(actor, async (db) => (await db.query('DELETE FROM deadlines WHERE id = $1', [id])).rowCount! > 0);
  },

  /* ---- Documents ---- */
  async listDocuments(actor: Actor, f: { search?: string; category?: string; scope?: 'library' | 'company'; company_id?: string }) {
    return withScope(actor, (db) => queryDocuments(db, f, true));
  },
  async createDocument(
    actor: Actor,
    meta: { title: string; description?: string; category?: string; company_id?: string | null; published: boolean },
    file: { originalname: string; buffer: Buffer }
  ) {
    const { mime, safeName } = validateUpload(file.originalname, file.buffer);
    return withScope(actor, async (db) => {
      const { rows } = await db.query<DocumentMeta>(
        `INSERT INTO documents (company_id, title, description, category, file_name, mime_type, size_bytes, published, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, company_id, title, description, category, file_name, mime_type, size_bytes, published, created_at`,
        [meta.company_id ?? null, meta.title, meta.description ?? null, meta.category ?? null,
         safeName, mime, file.buffer.length, meta.published, actor.id]
      );
      await db.query('INSERT INTO document_files (document_id, data) VALUES ($1,$2)', [rows[0].id, file.buffer]);
      return rows[0];
    });
  },
  async updateDocument(actor: Actor, id: string, d: { title?: string; description?: string; category?: string; published?: boolean }) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query<DocumentMeta>(
        `UPDATE documents SET title = COALESCE($2,title), description = COALESCE($3,description),
           category = COALESCE($4,category), published = COALESCE($5,published)
         WHERE id = $1
         RETURNING id, company_id, title, description, category, file_name, mime_type, size_bytes, published, created_at`,
        [id, d.title ?? null, d.description ?? null, d.category ?? null, d.published ?? null]
      );
      return rows[0] ?? null;
    });
  },
  async deleteDocument(actor: Actor, id: string) {
    return withScope(actor, async (db) => (await db.query('DELETE FROM documents WHERE id = $1', [id])).rowCount! > 0);
  },
  async getDocumentFile(actor: Actor, id: string) {
    return withScope(actor, (db) => fetchFile(db, id));
  },

  /* ---- Utilisateurs (pour rattachement) ---- */
  async listUsers(actor: Actor, search?: string) {
    return withScope(actor, async (db) => {
      const { rows } = await db.query(
        `SELECT u.id, u.email, u.name, u.role, u.created_at,
           COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name))
                     FROM company_members m JOIN companies c ON c.id = m.company_id
                     WHERE m.user_id = u.id), '[]'::json) AS companies
         FROM users u
         WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.name ILIKE $1)
         ORDER BY u.created_at DESC LIMIT 200`,
        [search ? `%${search}%` : null]
      );
      return rows;
    });
  },
};

/* ------------------------------------------------------------------ */
async function queryDeadlines(
  db: PoolClient,
  f: { from?: string; to?: string; company_id?: string; status?: string }
): Promise<Deadline[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.from) { params.push(f.from); where.push(`dl.due_date >= $${params.length}`); }
  if (f.to) { params.push(f.to); where.push(`dl.due_date <= $${params.length}`); }
  if (f.company_id) { params.push(f.company_id); where.push(`dl.company_id = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`dl.status = $${params.length}`); }
  const { rows } = await db.query<Deadline>(
    `SELECT dl.id, dl.company_id, c.name AS company_name, dl.kind, dl.title,
            to_char(dl.due_date,'YYYY-MM-DD') AS due_date, dl.status, dl.notes
     FROM deadlines dl JOIN companies c ON c.id = dl.company_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY dl.due_date ASC LIMIT 500`,
    params
  );
  return rows;
}

async function queryDocuments(
  db: PoolClient,
  f: { search?: string; category?: string; scope?: 'library' | 'company'; company_id?: string },
  _admin = false
): Promise<DocumentMeta[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.search) { params.push(`%${f.search}%`); where.push(`(d.title ILIKE $${params.length} OR d.file_name ILIKE $${params.length})`); }
  if (f.category) { params.push(f.category); where.push(`d.category = $${params.length}`); }
  if (f.scope === 'library') where.push('d.company_id IS NULL');
  if (f.scope === 'company') where.push('d.company_id IS NOT NULL');
  if (f.company_id) { params.push(f.company_id); where.push(`d.company_id = $${params.length}`); }
  const { rows } = await db.query<DocumentMeta>(
    `SELECT ${DOC_COLS} FROM documents d
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

async function fetchFile(db: PoolClient, id: string) {
  const { rows } = await db.query(
    `SELECT d.file_name, d.mime_type, f.data
     FROM documents d JOIN document_files f ON f.document_id = d.id WHERE d.id = $1`,
    [id]
  );
  return rows[0] as { file_name: string; mime_type: string; data: Buffer } | undefined;
}
