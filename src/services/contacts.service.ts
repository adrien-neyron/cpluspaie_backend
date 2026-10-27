import { withScope, anonymousScope } from './scope.service.js';
import type { DBUser } from '../types/auth.types.js';
import type { Contact, ContactStats, ContactStatus } from '../types/contact.types.js';

type Actor = Pick<DBUser, 'id' | 'role'>;

export interface NewContact {
  name: string;
  email: string;
  phone?: string | null;
  message: string;
  company_id?: string | null;
}

export const contactsService = {
  /** Formulaire public (visiteur non connecté). */
  async createPublic(data: NewContact): Promise<void> {
    await anonymousScope(async (db) => {
      // Pas de RETURNING : le visiteur anonyme n'a (volontairement) aucun droit de lecture.
      await db.query(
        `INSERT INTO contacts (user_id, name, email, phone, message, status, source)
         VALUES (NULL, $1, $2, $3, $4, 'new', 'public_form')`,
        [data.name, data.email, data.phone || null, data.message]
      );
    });
  },

  /** Demande d'un client connecté (devis, question…). */
  async createForUser(actor: Actor, data: NewContact): Promise<Contact> {
    return withScope(actor, async (db) => {
      const { rows } = await db.query<Contact>(
        `INSERT INTO contacts (user_id, name, email, phone, message, status, source)
         VALUES ($1, $2, $3, $4, $5, 'new', 'portal') RETURNING *`,
        [actor.id, data.name, data.email, data.phone || null, data.message]
      );
      return rows[0];
    });
  },

  async listMine(actor: Actor): Promise<Contact[]> {
    return withScope(actor, async (db) => {
      const { rows } = await db.query<Contact>(
        `SELECT id, user_id, name, email, phone, message, status, created_at, updated_at
         FROM contacts ORDER BY created_at DESC LIMIT 200`
      );
      return rows;
    });
  },

  /** Admin : toutes les demandes, filtrables. */
  async listAll(
    actor: Actor,
    opts: { page: number; limit: number; status?: string; search?: string; source?: string }
  ): Promise<{ contacts: Contact[]; total: number }> {
    return withScope(actor, async (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.status) {
        params.push(opts.status);
        where.push(`c.status = $${params.length}`);
      }
      if (opts.source) {
        params.push(opts.source);
        where.push(`c.source = $${params.length}`);
      }
      if (opts.search) {
        params.push(`%${opts.search}%`);
        where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.message ILIKE $${params.length})`);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (await db.query(`SELECT COUNT(*)::int AS n FROM contacts c ${w}`, params)).rows[0].n;
      params.push(opts.limit, (opts.page - 1) * opts.limit);
      const { rows } = await db.query<Contact>(
        `SELECT c.id, c.user_id, c.name, c.email, c.phone, c.message, c.status, c.source,
                c.admin_notes, c.company_id, c.created_at, c.updated_at
         FROM contacts c ${w}
         ORDER BY c.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return { contacts: rows, total };
    });
  },

  async update(
    actor: Actor,
    id: string,
    patch: { status?: ContactStatus; admin_notes?: string | null }
  ): Promise<Contact | null> {
    return withScope(actor, async (db) => {
      const { rows } = await db.query<Contact>(
        `UPDATE contacts SET
           status = COALESCE($2, status),
           admin_notes = CASE WHEN $3::boolean THEN $4 ELSE admin_notes END
         WHERE id = $1 RETURNING *`,
        [id, patch.status ?? null, patch.admin_notes !== undefined, patch.admin_notes ?? null]
      );
      return rows[0] ?? null;
    });
  },

  async remove(actor: Actor, id: string): Promise<boolean> {
    return withScope(actor, async (db) => {
      const r = await db.query('DELETE FROM contacts WHERE id = $1', [id]);
      return (r.rowCount ?? 0) > 0;
    });
  },

  async stats(actor: Actor): Promise<ContactStats> {
    return withScope(actor, async (db) => {
      const { rows } = await db.query<ContactStats>(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'new')::int AS new,
          COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS this_week
        FROM contacts`);
      return rows[0];
    });
  },
};
