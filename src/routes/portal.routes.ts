import { RequestHandler, Router } from 'express';
import { body, param, query } from 'express-validator';
import { requireClient } from '../middleware/roleCheck.middleware.js';
import { rules, wrap } from '../middleware/http.js';
import { clientPortal } from '../services/portal.service.js';
import { contactsService } from '../services/contacts.service.js';
import { httpError } from '../services/files.service.js';
import type { AuthRequest } from '../types/auth.types.js';

/** Espace client : toutes les données sont filtrées par RLS selon l'utilisateur authentifié. */
export function buildPortalRouter(auth: RequestHandler[]) {
  const r = Router();
  r.use(...auth, requireClient);

  r.get('/companies', wrap(async (req: AuthRequest, res) => {
    res.json({ data: await clientPortal.myCompanies(req.user!) });
  }));

  r.get('/dashboard', wrap(async (req: AuthRequest, res) => {
    res.json({ data: await clientPortal.dashboard(req.user!) });
  }));

  r.get('/deadlines',
    rules(
      query('from').optional().isISO8601({ strict: true }),
      query('to').optional().isISO8601({ strict: true }),
      query('company_id').optional().isUUID(),
      query('status').optional().isIn(['todo', 'in_progress', 'done'])
    ),
    wrap(async (req: AuthRequest, res) => {
      res.json({ data: await clientPortal.listDeadlines(req.user!, req.query as any) });
    }));

  r.patch('/deadlines/:id',
    rules(param('id').isUUID(), body('status').isIn(['todo', 'in_progress', 'done'])),
    wrap(async (req: AuthRequest, res) => {
      const d = await clientPortal.updateDeadlineStatus(req.user!, req.params.id, req.body.status);
      if (!d) throw httpError(404, 'Échéance introuvable ou non modifiable.');
      res.json({ data: d });
    }));

  r.get('/documents',
    rules(
      query('search').optional().isString().isLength({ max: 100 }),
      query('category').optional().isString().isLength({ max: 100 }),
      query('scope').optional().isIn(['library', 'company']),
      query('company_id').optional().isUUID()
    ),
    wrap(async (req: AuthRequest, res) => {
      res.json({ data: await clientPortal.listDocuments(req.user!, req.query as any) });
    }));

  r.get('/documents/:id/download', rules(param('id').isUUID()), wrap(async (req: AuthRequest, res) => {
    const f = await clientPortal.getDocumentFile(req.user!, req.params.id);
    if (!f) throw httpError(404, 'Document introuvable.');
    sendFile(res, f);
  }));

  // Demandes (devis / question) du client connecté
  r.get('/requests', wrap(async (req: AuthRequest, res) => {
    res.json({ data: { contacts: await contactsService.listMine(req.user!) } });
  }));

  r.post('/requests',
    rules(
      body('name').trim().isLength({ min: 1, max: 255 }),
      body('email').isEmail().normalizeEmail(),
      body('phone').optional({ values: 'falsy' }).isLength({ max: 50 }),
      body('message').trim().isLength({ min: 1, max: 5000 })
    ),
    wrap(async (req: AuthRequest, res) => {
      const created = await contactsService.createForUser(req.user!, req.body);
      res.status(201).json({ data: created });
    }));

  return r;
}

export function sendFile(res: any, f: { file_name: string; mime_type: string; data: Buffer }) {
  const ascii = f.file_name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', f.mime_type);
  res.setHeader('Content-Length', String(f.data.length));
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(f.data);
}
