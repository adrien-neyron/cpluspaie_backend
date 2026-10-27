import type { NextFunction, Response } from 'express';
import { pool } from '../src/config/database.js';
import { createApp } from '../src/createApp.js';
import type { AuthRequest } from '../src/types/auth.types.js';

/** Authentification factice : l'en-tête x-test-user porte l'id d'un utilisateur existant. */
const fakeAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const id = req.header('x-test-user');
  if (!id) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!rows[0]) { res.status(401).json({ error: 'Unauthorized' }); return; }
  req.user = rows[0];
  next();
};

export const app = createApp({ auth: [fakeAuth as any], publicRateLimitMax: 1000 });

export async function reset() {
  await pool.query(`TRUNCATE document_files, documents, deadlines, company_calendar_settings, company_contacts,
    company_members, invitations, companies, contacts, users RESTART IDENTITY CASCADE`);
}

export async function mkUser(email: string, role: 'Admin' | 'Client' = 'Client') {
  const { rows } = await pool.query(
    `INSERT INTO users (auth0_id, email, name, role) VALUES ($1,$2,$2,$3) RETURNING *`,
    [`auth0|${email}`, email, role]
  );
  return rows[0] as { id: string; email: string };
}

export async function mkCompany(name: string, memberIds: string[] = []) {
  const { rows } = await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [name]);
  await pool.query('INSERT INTO company_calendar_settings (company_id) VALUES ($1)', [rows[0].id]);
  for (const u of memberIds) await pool.query('INSERT INTO company_members VALUES ($1,$2)', [rows[0].id, u]);
  return rows[0].id as string;
}

export async function mkDeadline(companyId: string, kind: string, due: string, title = `${kind} ${due}`) {
  const { rows } = await pool.query(
    `INSERT INTO deadlines (company_id, kind, title, due_date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [companyId, kind, title, due]
  );
  return rows[0].id as string;
}

export const PDF = Buffer.from('%PDF-1.4\n%test content\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

export async function mkDoc(companyId: string | null, title: string, published = true) {
  const { rows } = await pool.query(
    `INSERT INTO documents (company_id, title, file_name, mime_type, size_bytes, published)
     VALUES ($1,$2,$3,'application/pdf',$4,$5) RETURNING id`,
    [companyId, title, `${title}.pdf`, PDF.length, published]
  );
  await pool.query('INSERT INTO document_files VALUES ($1,$2)', [rows[0].id, PDF]);
  return rows[0].id as string;
}
