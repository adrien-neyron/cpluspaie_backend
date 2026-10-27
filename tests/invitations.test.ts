import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/database.js';
import { auth0Service } from '../src/services/auth0.service.js';
import { syncOrCreateUser } from '../src/middleware/auth.middleware.js';
import { reset, mkCompany } from './helpers.js';

/** Appelle le middleware réel en simulant le profil renvoyé par Auth0. */
async function login(sub: string, profile: Record<string, unknown>) {
  (auth0Service as any).getUserInfo = async () => ({ user_id: sub, ...profile });
  const req: any = { auth: { payload: { sub } } };
  let status = 200; let body: any; let nextCalled = false;
  const res: any = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
  await syncOrCreateUser(req, res, () => { nextCalled = true; });
  return { status, body, nextCalled, user: req.user };
}

let companyId: string;
before(async () => {
  await reset();
  companyId = await mkCompany('Société Invitée');
  await pool.query(`INSERT INTO invitations (email, company_id) VALUES ('Invitee@Exemple.FR', $1)`, [companyId]);
});
after(async () => { await pool.end(); });

describe("pas d'inscription libre", () => {
  it('refuse un compte Auth0 inconnu et non invité (403)', async () => {
    const r = await login('auth0|stranger', { email: 'stranger@exemple.fr', email_verified: true });
    assert.equal(r.status, 403);
    assert.equal(r.nextCalled, false);
    assert.equal((await pool.query(`SELECT 1 FROM users WHERE email = 'stranger@exemple.fr'`)).rowCount, 0);
  });
  it("refuse un compte invité dont l'e-mail n'est pas vérifié", async () => {
    const r = await login('auth0|unverified', { email: 'invitee@exemple.fr', email_verified: false });
    assert.equal(r.status, 403);
    assert.equal((await pool.query(`SELECT 1 FROM users WHERE email = 'invitee@exemple.fr'`)).rowCount, 0);
  });
  it("accepte un compte invité (insensible à la casse), le rattache à son entreprise et clôt l'invitation", async () => {
    const r = await login('auth0|invitee', { email: 'invitee@exemple.fr', email_verified: true, name: 'Invitée' });
    assert.equal(r.nextCalled, true);
    assert.equal(r.user.role, 'Client');
    const m = await pool.query('SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2', [companyId, r.user.id]);
    assert.equal(m.rowCount, 1);
    const inv = await pool.query(`SELECT accepted_at FROM invitations WHERE lower(email) = 'invitee@exemple.fr'`);
    assert.ok(inv.rows[0].accepted_at);
  });
  it('un utilisateur déjà connu continue de passer', async () => {
    const r = await login('auth0|invitee', { email: 'invitee@exemple.fr', email_verified: true });
    assert.equal(r.nextCalled, true);
  });
  it("ne donne jamais le rôle Admin sans app_metadata.role = Admin posé côté Auth0", async () => {
    const r = await login('auth0|invitee', { email: 'invitee@exemple.fr', email_verified: true, user_metadata: { role: 'Admin' } });
    assert.equal(r.user.role, 'Client');
  });
  it("un Admin déclaré dans Auth0 (app_metadata) est accepté sans invitation", async () => {
    const r = await login('auth0|carole', { email: 'carole@cpaie.fr', email_verified: true, app_metadata: { role: 'Admin' } });
    assert.equal(r.nextCalled, true);
    assert.equal(r.user.role, 'Admin');
  });
  it("ADMIN_EMAILS : donne le rôle Admin à un e-mail vérifié listé, jamais à un e-mail non vérifié ni à un e-mail non listé", async () => {
    process.env.ADMIN_EMAILS = 'Boss@Cpaie.fr, autre@cpaie.fr';
    try {
      const ok = await login('auth0|boss', { email: 'boss@cpaie.fr', email_verified: true });
      assert.equal(ok.nextCalled, true);
      assert.equal(ok.user.role, 'Admin');
      const unverified = await login('auth0|boss2', { email: 'autre@cpaie.fr', email_verified: false });
      assert.equal(unverified.status, 403);
      const notListed = await login('auth0|nolist', { email: 'intrus@cpaie.fr', email_verified: true });
      assert.equal(notListed.status, 403);
    } finally { delete process.env.ADMIN_EMAILS; }
  });
});
