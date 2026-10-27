import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { validate } from './validation.middleware.js';
import { ValidationChain } from 'express-validator';
export { validate };

/** Express 4 ne gère pas les promesses rejetées : on les transmet à errorHandler. */
export const wrap =
  (fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export const rules = (...chains: ValidationChain[]) => validate(chains);
