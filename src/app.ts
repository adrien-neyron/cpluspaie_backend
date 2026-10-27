import { createApp } from './createApp.js';
import { productionAuth } from './middleware/authChain.js';
import aiRoutes from './routes/ai.routes.js';
import { env } from './config/environment.js';

// Origines autorisées (CORS) : ALLOWED_ORIGINS="https://cpaie.vercel.app,https://autre.domaine" (séparées par des virgules)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const app = createApp({
  auth: productionAuth,
  aiRouter: aiRoutes,
  // ALLOWED_ORIGINS s'ajoute aux origines par défaut (localhost + domaines du site) au lieu de les remplacer
  allowedOrigins: allowedOrigins.length
    ? [...new Set(['http://localhost:3000', 'https://cpluspaie.vercel.app', 'https://cpaie.vercel.app', ...allowedOrigins])]
    : undefined,
});

if (env.NODE_ENV === 'development') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

export default app;
