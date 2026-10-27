import { Request, Response, NextFunction } from 'express';

interface CustomError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
}

export const errorHandler = (err: CustomError, _req: Request, res: Response, _next: NextFunction): void => {
  if (err.name === 'UnauthorizedError' || err.name === 'InvalidTokenError') {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  if (err.name === 'MulterError') {
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (4 Mo maximum).' : 'Envoi de fichier invalide.',
    });
    return;
  }
  if ((err as any).type === 'entity.parse.failed' || (err as any).type === 'entity.too.large') {
    res.status(400).json({ error: 'Requête invalide' });
    return;
  }
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error('Error:', err);
  // Les erreurs internes (SQL, etc.) ne sont jamais renvoyées telles quelles au client.
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
};
