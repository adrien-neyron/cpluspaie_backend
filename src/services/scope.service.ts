import type { PoolClient } from 'pg';
import { pool } from '../config/database.js';
import type { DBUser } from '../types/auth.types.js';

/**
 * Exécute `fn` dans une transaction où :
 *  - le rôle PostgreSQL est basculé sur `cpaie_app` (NOBYPASSRLS),
 *  - l'identité de l'utilisateur est posée dans des variables de transaction
 *    lues par les politiques RLS (app_user_id(), app_is_admin()).
 *
 * Toute requête passée par ce helper est donc filtrée par la base elle-même,
 * même si une route oubliait un contrôle applicatif.
 */
export async function withScope<T>(
  user: Pick<DBUser, 'id' | 'role'> | null,
  fn: (db: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cpaie_app');
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)`, [
      user?.id ?? '',
      user?.role ?? '',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connexion déjà perdue */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Contexte « visiteur anonyme » (formulaire public) : aucune identité posée. */
export const anonymousScope = <T>(fn: (db: PoolClient) => Promise<T>) => withScope(null, fn);

/**
 * Contexte interne « système » (jamais déclenché par une entrée utilisateur directe) :
 * utilisé uniquement pour rattacher une invitation à un nouvel utilisateur lors de sa
 * première connexion, avant que l'application ne connaisse son identité.
 */
export const systemScope = <T>(fn: (db: PoolClient) => Promise<T>) =>
  withScope({ id: '00000000-0000-0000-0000-000000000000', role: 'Admin' }, fn);
