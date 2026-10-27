import { auth } from 'express-oauth2-jwt-bearer';
import { env } from './environment.js';

export const checkJwt = auth({
  audience: env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${env.AUTH0_DOMAIN}`,
  tokenSigningAlg: 'RS256',
});

export const auth0Config = {
  domain: env.AUTH0_DOMAIN,
  clientId: env.AUTH0_CLIENT_ID,
  clientSecret: env.AUTH0_CLIENT_SECRET,
  audience: env.AUTH0_AUDIENCE,
};