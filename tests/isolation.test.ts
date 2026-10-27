import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool } from '../src/config/database.js';
import { withScope, anonymousScope } from '../src/services/scope.service.js';
import { app, reset, mkUser, mkCompany, mkDeadline, mkDoc, PDF } from './helpers.js';

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

let admin: any, alice: any, bob: any, outsider: any;
let A: string, B: string;
let dlA_var: string, dlA_pay: string, dlB_var: string;
let docA: string, docB: string, docLib: string, docLibDraft: string, docADraft: string;

const as = (u: any) => ({ 'x-test-user': u.id });

before(async () => {
  await reset();
  admin = await mkUser('carole@cpaie.test', 'Admin');
  alice = await mkUser('alice@a.test');
  bob = await mkUser('bob@b.test');
  outsider = await mkUser('eve@nowhere.test');
  A = await mkCompany('Société A', [alice.id]);
  B = await mkCompany('Société B', [bob.id]);
  dlA_var = await mkDeadline(A, 'variables', iso(5));
  dlA_pay = await mkDeadline(A, 'payment', iso(8));
  dlB_var = await mkDeadline(B, 'variables', iso(5));
  docA = await mkDoc(A, 'Bulletin A');
  docADraft = await mkDoc(A, 'Brouillon A', false);
  docB = await mkDoc(B, 'Bulletin B');
  docLib = await mkDoc(null, 'Modèle contrat');
  docLibDraft = await mkDoc(null, 'Modèle non publié', false);
});
after(async () => { await pool.end(); });

describe('authentification', () => {
  it('refuse les requêtes sans identité (401)', async () => {
    for (const url of ['/api/portal/dashboard', '/api/portal/documents', '/api/admin/companies']) {
      assert.equal((await request(app).get(url)).status, 401, url);
    }
  });
  it('un client ne peut pas accéder aux routes admin (403)', async () => {
    for (const url of ['/api/admin/companies', '/api/admin/users', '/api/admin/contacts', '/api/admin/stats', '/api/admin/documents']) {
      assert.equal((await request(app).get(url).set(as(alice))).status, 403, url);
    }
    const r = await request(app).post('/api/admin/companies').set(as(alice)).send({ name: 'Pirate' });
    assert.equal(r.status, 403);
  });
});

describe('isolation entre entreprises (API)', () => {
  it("le tableau de bord n'expose que les échéances de sa propre entreprise", async () => {
    const r = await request(app).get('/api/portal/dashboard').set(as(alice));
    assert.equal(r.status, 200);
    const ids = r.body.data.deadlines.map((d: any) => d.id);
    assert.deepEqual(ids.sort(), [dlA_var, dlA_pay].sort());
    assert.ok(!ids.includes(dlB_var));
  });
  it('ne liste pas les échéances d’une autre entreprise, même en la ciblant explicitement', async () => {
    const r = await request(app).get(`/api/portal/deadlines?company_id=${B}`).set(as(alice));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 0);
  });
  it('ne voit que ses entreprises', async () => {
    const r = await request(app).get('/api/portal/companies').set(as(alice));
    assert.deepEqual(r.body.data.map((c: any) => c.name), ['Société A']);
    assert.ok(!('notes' in r.body.data[0]), 'les notes internes ne sont pas exposées');
  });
  it('un utilisateur sans entreprise ne voit rien', async () => {
    const r = await request(app).get('/api/portal/dashboard').set(as(outsider));
    assert.equal(r.body.data.deadlines.length, 0);
    const docs = await request(app).get('/api/portal/documents').set(as(outsider));
    assert.deepEqual(docs.body.data.map((d: any) => d.title), ['Modèle contrat']); // seule la bibliothèque publiée
  });
  it('documents : propres + bibliothèque publiée uniquement', async () => {
    const r = await request(app).get('/api/portal/documents').set(as(alice));
    const titles = r.body.data.map((d: any) => d.title).sort();
    assert.deepEqual(titles, ['Bulletin A', 'Modèle contrat']);
  });
  it('recherche et filtres de documents', async () => {
    const r = await request(app).get('/api/portal/documents?search=contrat').set(as(alice));
    assert.deepEqual(r.body.data.map((d: any) => d.title), ['Modèle contrat']);
    const lib = await request(app).get('/api/portal/documents?scope=library').set(as(alice));
    assert.equal(lib.body.data.length, 1);
  });
  it('téléchargement : autorisé sur ses documents et la bibliothèque, 404 ailleurs', async () => {
    const ok = await request(app).get(`/api/portal/documents/${docA}/download`).set(as(alice)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, PDF);
    assert.match(ok.headers['content-disposition'], /^attachment;/);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal((await request(app).get(`/api/portal/documents/${docLib}/download`).set(as(alice))).status, 200);
    for (const id of [docB, docADraft, docLibDraft]) {
      assert.equal((await request(app).get(`/api/portal/documents/${id}/download`).set(as(alice))).status, 404, id);
    }
    assert.equal((await request(app).get(`/api/portal/documents/${docA}/download`)).status, 401);
    assert.equal((await request(app).get(`/api/portal/documents/${docA}/download`).set(as(bob))).status, 404);
  });
  it('un client ne peut modifier que le statut des échéances « variables » de son entreprise', async () => {
    assert.equal((await request(app).patch(`/api/portal/deadlines/${dlB_var}`).set(as(alice)).send({ status: 'done' })).status, 404);
    assert.equal((await request(app).patch(`/api/portal/deadlines/${dlA_pay}`).set(as(alice)).send({ status: 'done' })).status, 404);
    assert.equal((await request(app).patch(`/api/portal/deadlines/${dlA_var}`).set(as(alice)).send({ status: 'bogus' })).status, 400);
    const ok = await request(app).patch(`/api/portal/deadlines/${dlA_var}`).set(as(alice)).send({ status: 'done' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.status, 'done');
    const { rows } = await pool.query('SELECT status FROM deadlines WHERE id = $1', [dlB_var]);
    assert.equal(rows[0].status, 'todo');
  });
});

describe('RLS appliquée par la base (sans passer par les contrôles de l’API)', () => {
  it('SELECT brut : un client ne voit que ses lignes', async () => {
    await withScope(alice, async (db) => {
      assert.equal((await db.query('SELECT * FROM companies')).rowCount, 1);
      assert.equal((await db.query('SELECT * FROM deadlines')).rowCount, 2);
      assert.equal((await db.query('SELECT * FROM documents WHERE id = $1', [docB])).rowCount, 0);
      assert.equal((await db.query('SELECT * FROM document_files WHERE document_id = $1', [docB])).rowCount, 0);
      assert.equal((await db.query('SELECT * FROM users')).rowCount, 1);
      assert.equal((await db.query('SELECT * FROM invitations')).rowCount, 0);
      assert.equal((await db.query('SELECT * FROM company_members')).rowCount, 1);
    });
  });
  it('écriture brute : impossible de modifier/supprimer les données d’une autre entreprise', async () => {
    await withScope(alice, async (db) => {
      assert.equal((await db.query(`UPDATE companies SET name = 'hack' WHERE id = $1`, [B])).rowCount, 0);
      assert.equal((await db.query(`UPDATE companies SET name = 'hack' WHERE id = $1`, [A])).rowCount, 0); // même la sienne : lecture seule
      assert.equal((await db.query(`DELETE FROM documents WHERE id = $1`, [docA])).rowCount, 0);
      assert.equal((await db.query(`UPDATE deadlines SET status='done' WHERE id = $1`, [dlB_var])).rowCount, 0);
    });
    await assert.rejects(withScope(alice, (db) => db.query(`INSERT INTO companies (name) VALUES ('x')`)));
    await assert.rejects(withScope(alice, (db) =>
      db.query(`INSERT INTO company_members (company_id, user_id) VALUES ($1,$2)`, [B, alice.id])));
    await assert.rejects(withScope(alice, (db) =>
      db.query(`INSERT INTO deadlines (company_id, kind, title, due_date) VALUES ($1,'other','x','2030-01-01')`, [B])));
    const { rows } = await pool.query('SELECT name FROM companies ORDER BY name');
    assert.deepEqual(rows.map((r) => r.name), ['Société A', 'Société B']);
  });
  it('un client ne peut pas se promouvoir (pas d’écriture sur users, ni d’identité forgée)', async () => {
    await assert.rejects(withScope(alice, (db) => db.query(`UPDATE users SET role = 'Admin' WHERE id = $1`, [alice.id])));
    await withScope({ id: alice.id, role: 'Client' }, async (db) => {
      assert.equal((await db.query('SELECT * FROM companies')).rowCount, 1);
    });
  });
  it('les tables sans politique (paiements) sont inaccessibles au rôle applicatif', async () => {
    await assert.rejects(withScope(alice, (db) => db.query('SELECT * FROM payments')));
  });
  it('un visiteur anonyme ne lit rien', async () => {
    await anonymousScope(async (db) => {
      for (const t of ['companies', 'deadlines', 'documents', 'document_files', 'contacts', 'users', 'invitations']) {
        assert.equal((await db.query(`SELECT * FROM ${t}`)).rowCount, 0, t);
      }
    });
  });
});

describe('formulaire de contact public', () => {
  const valid = { name: 'Jean Dupont', email: 'jean@exemple.fr', message: 'Bonjour, je souhaite un devis.', consent: true };
  it('enregistre une demande valide (source = public_form)', async () => {
    const r = await request(app).post('/api/public/contact').send(valid);
    assert.equal(r.status, 201);
    const { rows } = await pool.query(`SELECT * FROM contacts WHERE email = 'jean@exemple.fr'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'public_form');
    assert.equal(rows[0].user_id, null);
  });
  it('refuse les données invalides ou sans consentement (400)', async () => {
    assert.equal((await request(app).post('/api/public/contact').send({ ...valid, email: 'pas-un-mail' })).status, 400);
    assert.equal((await request(app).post('/api/public/contact').send({ ...valid, consent: false })).status, 400);
    assert.equal((await request(app).post('/api/public/contact').send({ ...valid, message: '' })).status, 400);
    assert.equal((await request(app).post('/api/public/contact').send({ ...valid, message: 'x'.repeat(6000) })).status, 400);
  });
  it('ignore silencieusement les robots (champ piège)', async () => {
    const r = await request(app).post('/api/public/contact').send({ ...valid, email: 'bot@spam.fr', website: 'http://spam' });
    assert.equal(r.status, 202);
    assert.equal((await pool.query(`SELECT 1 FROM contacts WHERE email = 'bot@spam.fr'`)).rowCount, 0);
  });
  it('est visible côté admin uniquement', async () => {
    const adminRes = await request(app).get('/api/admin/contacts').set(as(admin));
    assert.equal(adminRes.status, 200);
    assert.ok(adminRes.body.data.contacts.some((c: any) => c.email === 'jean@exemple.fr'));
    const mine = await request(app).get('/api/portal/requests').set(as(alice));
    assert.equal(mine.body.data.contacts.length, 0);
  });
  it('un client crée et ne retrouve que ses propres demandes', async () => {
    const c = await request(app).post('/api/portal/requests').set(as(alice))
      .send({ name: 'Société A', email: 'alice@a.test', message: 'Question sur un bulletin' });
    assert.equal(c.status, 201);
    await request(app).post('/api/portal/requests').set(as(bob))
      .send({ name: 'Société B', email: 'bob@b.test', message: 'Autre question' });
    const mine = await request(app).get('/api/portal/requests').set(as(alice));
    assert.deepEqual(mine.body.data.contacts.map((x: any) => x.name), ['Société A']);
  });
});

describe('CRM administrateur', () => {
  let cid: string;
  it('CRUD entreprise', async () => {
    const c = await request(app).post('/api/admin/companies').set(as(admin))
      .send({ name: 'Nouvelle SARL', siret: '123 456 789 00012', headcount: 12, ccn: 'Syntec', notes: 'note interne' });
    assert.equal(c.status, 201);
    cid = c.body.data.id;
    assert.equal((await request(app).post('/api/admin/companies').set(as(admin)).send({ name: '' })).status, 400);
    const u = await request(app).put(`/api/admin/companies/${cid}`).set(as(admin)).send({ status: 'archived' });
    assert.equal(u.body.data.status, 'archived');
    const g = await request(app).get(`/api/admin/companies/${cid}`).set(as(admin));
    assert.equal(g.body.data.name, 'Nouvelle SARL');
    assert.ok(g.body.data.calendar_settings);
    const list = await request(app).get('/api/admin/companies?search=Nouvelle').set(as(admin));
    assert.equal(list.body.data.length, 1);
    assert.equal((await request(app).get(`/api/admin/companies/${'0'.repeat(8)}-0000-4000-8000-000000000000`).set(as(admin))).status, 404);
    assert.equal((await request(app).get('/api/admin/companies/pas-un-uuid').set(as(admin))).status, 400);
  });
  it('interlocuteurs, rattachement d’un utilisateur, invitation', async () => {
    const ct = await request(app).post(`/api/admin/companies/${cid}/contacts`).set(as(admin))
      .send({ full_name: 'Marie Martin', email: 'marie@nouvelle.fr', job_title: 'DRH' });
    assert.equal(ct.status, 201);
    const up = await request(app).put(`/api/admin/company-contacts/${ct.body.data.id}`).set(as(admin)).send({ phone: '0102030405' });
    assert.equal(up.body.data.phone, '0102030405');
    assert.equal((await request(app).post(`/api/admin/companies/${cid}/members`).set(as(admin)).send({ user_id: outsider.id })).status, 201);
    const dash = await request(app).get('/api/portal/companies').set(as(outsider));
    assert.deepEqual(dash.body.data.map((c: any) => c.name), ['Nouvelle SARL']);
    await request(app).delete(`/api/admin/companies/${cid}/members/${outsider.id}`).set(as(admin));
    assert.equal((await request(app).get('/api/portal/companies').set(as(outsider))).body.data.length, 0);
    const inv = await request(app).post('/api/admin/invitations').set(as(admin)).send({ email: 'Nouveau.Client@Exemple.fr', company_id: cid });
    assert.equal(inv.status, 201);
    assert.equal((await request(app).delete(`/api/admin/invitations/${inv.body.data.id}`).set(as(admin))).status, 200);
    assert.equal((await request(app).delete(`/api/admin/company-contacts/${ct.body.data.id}`).set(as(admin))).status, 200);
  });
  it('génération du calendrier personnalisable, sans doublons', async () => {
    const s = await request(app).put(`/api/admin/companies/${cid}/calendar-settings`).set(as(admin))
      .send({ variables_day: 18, validation_day: 22, payment_day: 31, social_day: 5 });
    assert.equal(s.status, 200);
    const g1 = await request(app).post(`/api/admin/companies/${cid}/calendar/generate`).set(as(admin)).send({ start_month: '2027-02', months: 3 });
    assert.equal(g1.body.data.created, 12);
    const g2 = await request(app).post(`/api/admin/companies/${cid}/calendar/generate`).set(as(admin)).send({ start_month: '2027-02', months: 3 });
    assert.equal(g2.body.data.created, 0);
    const l = await request(app).get(`/api/admin/deadlines?company_id=${cid}&kind=payment`).set(as(admin));
    const pay = l.body.data.filter((d: any) => d.kind === 'payment').map((d: any) => d.due_date);
    assert.deepEqual(pay, ['2027-02-28', '2027-03-31', '2027-04-30']); // jour 31 borné à la fin du mois
    assert.equal((await request(app).post(`/api/admin/companies/${cid}/calendar/generate`).set(as(admin)).send({ start_month: '2027-13', months: 3 })).status, 400);
    assert.equal((await request(app).put(`/api/admin/companies/${cid}/calendar-settings`).set(as(admin))
      .send({ variables_day: 40, validation_day: 22, payment_day: 31, social_day: 5 })).status, 400);
  });
  it('CRUD échéance + statut', async () => {
    const c = await request(app).post('/api/admin/deadlines').set(as(admin))
      .send({ company_id: cid, kind: 'other', title: 'Rendez-vous annuel', due_date: '2027-06-01' });
    assert.equal(c.status, 201);
    const u = await request(app).put(`/api/admin/deadlines/${c.body.data.id}`).set(as(admin)).send({ status: 'in_progress', due_date: '2027-06-02' });
    assert.equal(u.body.data.status, 'in_progress');
    assert.equal(u.body.data.due_date, '2027-06-02');
    assert.equal((await request(app).delete(`/api/admin/deadlines/${c.body.data.id}`).set(as(admin))).status, 200);
    assert.equal((await request(app).delete(`/api/admin/deadlines/${c.body.data.id}`).set(as(admin))).status, 404);
  });
  it('dépôt, publication, modification et suppression de documents', async () => {
    const up = await request(app).post('/api/admin/documents').set(as(admin))
      .field('title', 'Contrat type').field('category', 'Contrats').field('published', 'false')
      .attach('file', PDF, 'contrat.pdf');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const id = up.body.data.id;
    // non publié => invisible du client
    assert.ok(!(await request(app).get('/api/portal/documents').set(as(alice))).body.data.some((d: any) => d.id === id));
    const pub = await request(app).put(`/api/admin/documents/${id}`).set(as(admin)).send({ published: true });
    assert.equal(pub.body.data.published, true);
    assert.ok((await request(app).get('/api/portal/documents').set(as(alice))).body.data.some((d: any) => d.id === id));
    assert.equal((await request(app).get(`/api/admin/documents/${id}/download`).set(as(admin))).status, 200);
    assert.equal((await request(app).delete(`/api/admin/documents/${id}`).set(as(admin))).status, 200);
    assert.equal((await request(app).get(`/api/portal/documents/${id}/download`).set(as(alice))).status, 404);
  });
  it('contrôle des fichiers : extension, signature, taille', async () => {
    const post = (buf: Buffer, name: string) => request(app).post('/api/admin/documents').set(as(admin)).field('title', 't').attach('file', buf, name);
    assert.equal((await post(Buffer.from('MZ binaire'), 'virus.exe')).status, 400);
    assert.equal((await post(Buffer.from('<script>alert(1)</script>'), 'faux.pdf')).status, 400);
    assert.equal((await post(Buffer.from('PK\u0003\u0004rest'), 'ok.docx')).status, 201);
    assert.equal((await post(Buffer.from('PK\u0003\u0004rest'), 'ok.xlsx')).status, 201);
    assert.equal((await post(Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), 'gros.pdf')).status, 413);
    assert.equal((await request(app).post('/api/admin/documents').set(as(admin)).field('title', 't')).status, 400);
  });
  it('rattacher un document à une entreprise le rend visible uniquement de ses membres', async () => {
    const up = await request(app).post('/api/admin/documents').set(as(admin))
      .field('title', 'Bulletin mars').field('company_id', B).field('published', 'true').attach('file', PDF, 'mars.pdf');
    assert.equal(up.status, 201);
    assert.ok((await request(app).get('/api/portal/documents').set(as(bob))).body.data.some((d: any) => d.id === up.body.data.id));
    assert.ok(!(await request(app).get('/api/portal/documents').set(as(alice))).body.data.some((d: any) => d.id === up.body.data.id));
  });
  it('statut des demandes et notes internes', async () => {
    const list = await request(app).get('/api/admin/contacts?search=devis').set(as(admin));
    const id = list.body.data.contacts[0].id;
    const u = await request(app).put(`/api/admin/contacts/${id}`).set(as(admin)).send({ status: 'in_progress', admin_notes: 'Rappeler lundi' });
    assert.equal(u.body.data.contact.status, 'in_progress');
    assert.equal(u.body.data.contact.admin_notes, 'Rappeler lundi');
    assert.equal((await request(app).put(`/api/admin/contacts/${id}`).set(as(admin)).send({ status: 'nope' })).status, 400);
    const stats = await request(app).get('/api/admin/stats').set(as(admin));
    assert.ok(stats.body.data.stats.total >= 3);
  });
  it('suppression d’entreprise en cascade', async () => {
    assert.equal((await request(app).delete(`/api/admin/companies/${cid}`).set(as(admin))).status, 200);
    assert.equal((await pool.query('SELECT 1 FROM deadlines WHERE company_id = $1', [cid])).rowCount, 0);
  });
});

describe('profil /auth/me', () => {
  it('renvoie le rôle appliqué côté serveur', async () => {
    const a = await request(app).get('/api/auth/me').set(as(alice));
    assert.equal(a.status, 200);
    assert.equal(a.body.role, 'Client');
    assert.ok(!('auth0_id' in a.body) && !('metadata' in a.body), 'aucune donnée interne exposée');
    assert.equal((await request(app).get('/api/auth/me').set(as(admin))).body.role, 'Admin');
    assert.equal((await request(app).get('/api/auth/me')).status, 401);
  });
});
