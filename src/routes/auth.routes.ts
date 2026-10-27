import { RequestHandler, Router } from 'express';
import { AuthRequest } from '../types/auth.types.js';

/** GET /auth/me : profil applicatif (id, email, rôle). Refuse (403) les comptes non invités. */
export function buildAuthRouter(auth: RequestHandler[]) {
  const router = Router();
  router.get('/me', ...auth, (req: AuthRequest, res) => {
    const { id, email, name, role } = req.user!;
    res.status(200).json({ id, email, name, role });
  });
  return router;
}
