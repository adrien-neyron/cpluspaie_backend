import type { RequestHandler } from 'express';
import { checkJwt } from '../config/auth0.js';
import { syncOrCreateUser } from './auth.middleware.js';

/** Chaîne d'authentification de production : JWT Auth0 + utilisateur applicatif invité. */
export const productionAuth: RequestHandler[] = [checkJwt, syncOrCreateUser as unknown as RequestHandler];
