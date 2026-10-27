import express, { Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './middleware/errorHandler.middleware.js';
import { requireClient } from './middleware/roleCheck.middleware.js';
import { buildPortalRouter } from './routes/portal.routes.js';
import { buildAdminRouter } from './routes/admin.routes.js';
import { buildPublicRouter } from './routes/public.routes.js';
import { buildAuthRouter } from './routes/auth.routes.js';

export interface AppOptions {
  /** Chaîne d'authentification (JWT Auth0 + utilisateur applicatif). Injectable pour les tests. */
  auth: RequestHandler[];
  /** Routes IA existantes (OpenAI), montées derrière l'authentification. */
  aiRouter?: express.Router;
  allowedOrigins?: string[];
  publicRateLimitMax?: number;
}

export function createApp(opts: AppOptions) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());

  const corsOptions = {
    origin: opts.allowedOrigins ?? ['http://localhost:3000', 'https://cpluspaie.vercel.app', 'https://cpaie.vercel.app'],
    credentials: true,
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(compression() as unknown as RequestHandler);

  // Limite générale (les routes sensibles ont en plus leur propre limiteur)
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Too many requests' } });
  app.use('/api', (req, res, next) => (req.method === 'OPTIONS' ? next() : limiter(req, res, next)));

  app.use(express.json({ limit: '100kb' })); // les fichiers passent par multipart (multer), pas par JSON
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/public', buildPublicRouter({ rateLimitMax: opts.publicRateLimitMax }));
  app.use('/api/portal', buildPortalRouter(opts.auth));
  app.use('/api/admin', buildAdminRouter(opts.auth));
  app.use('/api/auth', buildAuthRouter(opts.auth));

  if (opts.aiRouter) {
    const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: "Limite d'analyses atteinte" } });
    app.use('/api/ai', aiLimiter, ...opts.auth, requireClient, opts.aiRouter);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Route not found' });
  });
  app.use(errorHandler);
  return app;
}
