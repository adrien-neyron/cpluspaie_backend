import { Response, NextFunction } from 'express';
import { AuthRequest, UserRole } from '../types/auth.types.js';
import { auth0Service, Auth0User } from '../services/auth0.service.js';
import { dbService } from '../services/database.service.js';
import { systemScope } from '../services/scope.service.js';

/** Cache court des profils Auth0 : évite un appel Management API (quota limité) à chaque requête. */
/** E-mails administrateurs déclarés côté serveur (variable ADMIN_EMAILS, séparés par des virgules). L'e-mail doit être vérifié dans Auth0. */
const adminEmails = (): string[] => (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const TTL_MS = 5 * 60 * 1000;
const profileCache = new Map<string, { exp: number; user: Auth0User & { email_verified?: boolean } }>();

async function getProfile(sub: string) {
  const hit = profileCache.get(sub);
  if (hit && hit.exp > Date.now()) return hit.user;
  const user = (await auth0Service.getUserInfo(sub)) as Auth0User & { email_verified?: boolean };
  profileCache.set(sub, { exp: Date.now() + TTL_MS, user });
  return user;
}

/**
 * Après vérification du JWT (checkJwt) :
 *  - charge/crée l'utilisateur applicatif,
 *  - REFUSE tout compte inconnu qui n'a pas été invité (pas d'inscription libre),
 *  - rattache l'utilisateur à l'entreprise de son invitation lors de la 1re connexion.
 */
export const syncOrCreateUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sub = req.auth?.payload?.sub;
    if (!sub) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const auth0User = await getProfile(sub);

    let role: UserRole = 'Client';
    if (auth0User.app_metadata?.role === 'Admin') role = 'Admin';
    else if (req.auth?.payload?.['https://api.yourapp.com/roles']?.includes?.('Admin')) role = 'Admin';
    else if (auth0User.email_verified && auth0User.email && adminEmails().includes(auth0User.email.toLowerCase())) role = 'Admin';

    const existing = await dbService.getUserByAuth0Id(sub);
    let invitation: { id: string; company_id: string | null } | null = null;

    if (!existing && role !== 'Admin') {
      // Compte inconnu : il doit avoir été invité par la consultante, avec un e-mail vérifié.
      if (!auth0User.email_verified) {
        res.status(403).json({ error: 'Adresse e-mail non vérifiée.' });
        return;
      }
      invitation = await systemScope(async (db) => {
        const r = await db.query(
          `SELECT id, company_id FROM invitations WHERE lower(email) = lower($1)`,
          [auth0User.email]
        );
        return r.rows[0] ?? null;
      });
      if (!invitation) {
        res.status(403).json({ error: "Accès sur invitation uniquement. Contactez votre consultante." });
        return;
      }
    }

    const dbUser = await dbService.createOrUpdateUser(
      sub,
      auth0User.email,
      auth0User.name || auth0User.nickname || null,
      role,
      auth0User.user_metadata || {}
    );

    if (invitation) {
      await systemScope(async (db) => {
        if (invitation!.company_id) {
          await db.query(
            'INSERT INTO company_members (company_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [invitation!.company_id, dbUser.id]
          );
        }
        await db.query('UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1', [invitation!.id]);
      });
    }

    if (!existing || existing.role !== dbUser.role) console.log(`[auth] ${dbUser.email} → rôle ${dbUser.role}`);
    req.user = dbUser;
    next();
  } catch (error) {
    console.error('syncOrCreateUser error:', error);
    res.status(500).json({ error: 'Failed to sync user' });
  }
};
