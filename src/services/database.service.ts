import { pool } from '../config/database.js';
import { DBUser, UserRole } from '../types/auth.types.js';
import { QueryResult } from 'pg';

/**
 * Accès « propriétaire » limité à la table users (synchronisation Auth0).
 * Toutes les données métier (entreprises, échéances, documents, demandes)
 * passent par scope.service.ts, donc par les politiques RLS.
 */
export class DatabaseService {
  async createOrUpdateUser(
    auth0Id: string,
    email: string,
    name: string | null,
    role: UserRole,
    metadata: Record<string, unknown> = {}
  ): Promise<DBUser> {
    const result: QueryResult<DBUser> = await pool.query(
      `INSERT INTO users (auth0_id, email, name, role, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (auth0_id)
       DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
                     metadata = EXCLUDED.metadata, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [auth0Id, email, name, role, JSON.stringify(metadata)]
    );
    return result.rows[0];
  }

  async getUserByAuth0Id(auth0Id: string): Promise<DBUser | null> {
    const result: QueryResult<DBUser> = await pool.query('SELECT * FROM users WHERE auth0_id = $1', [auth0Id]);
    return result.rows[0] || null;
  }
}

export const dbService = new DatabaseService();
