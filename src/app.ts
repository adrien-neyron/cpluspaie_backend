import { createApp } from './createApp.js';
import { productionAuth } from './middleware/authChain.js';
import aiRoutes from './routes/ai.routes.js';
import { env } from './config/environment.js';

const app = createApp({ auth: productionAuth, aiRouter: aiRoutes });

if (env.NODE_ENV === 'development') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

export default app;
