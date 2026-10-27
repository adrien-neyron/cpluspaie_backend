import { RequestHandler, Router } from 'express';
import { body, param, query } from 'express-validator';
import { requireAdmin } from '../middleware/roleCheck.middleware.js';
import { rules, wrap } from '../middleware/http.js';
import { upload } from '../middleware/upload.middleware.js';
import { adminCrm } from '../services/portal.service.js';
import { contactsService } from '../services/contacts.service.js';
import { httpError } from '../services/files.service.js';
import { sendFile } from './portal.routes.js';
import type { AuthRequest } from '../types/auth.types.js';

const uuid = (n: string) => param(n).isUUID();
const day = (n: string) => body(n).isInt({ min: 1, max: 31 }).toInt();

/** Espace administrateur : JWT valide + rôle Admin vérifié en base, puis RLS (p_admin_all). */
export function buildAdminRouter(auth: RequestHandler[]) {
  const r = Router();
  r.use(...auth, requireAdmin);

  /* ---------- Demandes de contact ---------- */
  r.get('/contacts',
    rules(query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 }),
      query('status').optional().isIn(['new', 'in_progress', 'resolved', 'closed'])),
    wrap(async (req: AuthRequest, res) => {
      const q = req.query as Record<string, string>;
      const data = await contactsService.listAll(req.user!, {
        page: Number(q.page) || 1, limit: Number(q.limit) || 50,
        status: q.status, search: q.search?.slice(0, 100), source: q.source,
      });
      res.json({ success: true, data });
    }));
  r.put('/contacts/:id',
    rules(uuid('id'), body('status').optional().isIn(['new', 'in_progress', 'resolved', 'closed']),
      body('admin_notes').optional({ values: 'null' }).isString().isLength({ max: 5000 })),
    wrap(async (req: AuthRequest, res) => {
      const c = await contactsService.update(req.user!, req.params.id, {
        status: req.body.status, admin_notes: req.body.admin_notes });
      if (!c) throw httpError(404, 'Demande introuvable');
      res.json({ success: true, data: { contact: c } });
    }));
  r.delete('/contacts/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    if (!(await contactsService.remove(req.user!, req.params.id))) throw httpError(404, 'Demande introuvable');
    res.json({ success: true });
  }));
  r.get('/stats', wrap(async (req: AuthRequest, res) => {
    res.json({ success: true, data: { stats: await contactsService.stats(req.user!) } });
  }));

  /* ---------- Utilisateurs / invitations ---------- */
  r.get('/users', wrap(async (req: AuthRequest, res) => {
    res.json({ success: true, data: await adminCrm.listUsers(req.user!, (req.query.search as string)?.slice(0, 100)) });
  }));
  r.post('/invitations',
    rules(body('email').isEmail().normalizeEmail(), body('company_id').optional({ values: 'null' }).isUUID()),
    wrap(async (req: AuthRequest, res) => {
      res.status(201).json({ data: await adminCrm.invite(req.user!, req.body.email, req.body.company_id ?? null) });
    }));
  r.delete('/invitations/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    if (!(await adminCrm.deleteInvitation(req.user!, req.params.id))) throw httpError(404, 'Invitation introuvable');
    res.json({ success: true });
  }));

  /* ---------- Entreprises ---------- */
  const companyBody = [
    body('name').trim().isLength({ min: 1, max: 255 }),
    body('siret').optional({ values: 'falsy' }).matches(/^[0-9 ]{9,20}$/),
    body('ccn').optional({ values: 'falsy' }).isLength({ max: 255 }),
    body('headcount').optional({ values: 'null' }).isInt({ min: 0, max: 1000000 }).toInt(),
    body('status').optional().isIn(['prospect', 'active', 'archived']),
    body('notes').optional({ values: 'null' }).isString().isLength({ max: 10000 }),
  ];
  r.get('/companies', wrap(async (req: AuthRequest, res) => {
    const q = req.query as Record<string, string>;
    res.json({ data: await adminCrm.listCompanies(req.user!, { search: q.search?.slice(0, 100), status: q.status }) });
  }));
  r.post('/companies', rules(...companyBody), wrap(async (req: AuthRequest, res) => {
    res.status(201).json({ data: await adminCrm.createCompany(req.user!, req.body) });
  }));
  r.get('/companies/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    const c = await adminCrm.getCompany(req.user!, req.params.id);
    if (!c) throw httpError(404, 'Entreprise introuvable');
    res.json({ data: c });
  }));
  r.put('/companies/:id', rules(uuid('id'), ...companyBody.map((c) => c.optional())), wrap(async (req: AuthRequest, res) => {
    const c = await adminCrm.updateCompany(req.user!, req.params.id, req.body);
    if (!c) throw httpError(404, 'Entreprise introuvable');
    res.json({ data: c });
  }));
  r.delete('/companies/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    if (!(await adminCrm.deleteCompany(req.user!, req.params.id))) throw httpError(404, 'Entreprise introuvable');
    res.json({ success: true });
  }));

  /* ---------- Interlocuteurs & membres ---------- */
  r.post('/companies/:id/contacts',
    rules(uuid('id'), body('full_name').trim().isLength({ min: 1, max: 255 }),
      body('email').optional({ values: 'falsy' }).isEmail(), body('phone').optional({ values: 'falsy' }).isLength({ max: 50 }),
      body('job_title').optional({ values: 'falsy' }).isLength({ max: 255 })),
    wrap(async (req: AuthRequest, res) => {
      res.status(201).json({ data: await adminCrm.addContact(req.user!, req.params.id, req.body) });
    }));
  r.put('/company-contacts/:id',
    rules(uuid('id'), body('email').optional({ values: 'falsy' }).isEmail()),
    wrap(async (req: AuthRequest, res) => {
      const c = await adminCrm.updateContact(req.user!, req.params.id, req.body);
      if (!c) throw httpError(404, 'Interlocuteur introuvable');
      res.json({ data: c });
    }));
  r.delete('/company-contacts/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    if (!(await adminCrm.deleteContact(req.user!, req.params.id))) throw httpError(404, 'Interlocuteur introuvable');
    res.json({ success: true });
  }));
  r.post('/companies/:id/members', rules(uuid('id'), body('user_id').isUUID()), wrap(async (req: AuthRequest, res) => {
    await adminCrm.addMember(req.user!, req.params.id, req.body.user_id);
    res.status(201).json({ success: true });
  }));
  r.delete('/companies/:id/members/:userId', rules(uuid('id'), uuid('userId')), wrap(async (req: AuthRequest, res) => {
    await adminCrm.removeMember(req.user!, req.params.id, req.params.userId);
    res.json({ success: true });
  }));

  /* ---------- Calendrier ---------- */
  r.put('/companies/:id/calendar-settings',
    rules(uuid('id'), day('variables_day'), day('validation_day'), day('payment_day'), day('social_day')),
    wrap(async (req: AuthRequest, res) => {
      res.json({ data: await adminCrm.saveCalendarSettings(req.user!, req.params.id, req.body) });
    }));
  r.post('/companies/:id/calendar/generate',
    rules(uuid('id'), body('start_month').matches(/^\d{4}-(0[1-9]|1[0-2])$/), body('months').isInt({ min: 1, max: 24 }).toInt()),
    wrap(async (req: AuthRequest, res) => {
      res.json({ data: await adminCrm.generateCalendar(req.user!, req.params.id, req.body.start_month, req.body.months) });
    }));
  r.get('/deadlines',
    rules(query('from').optional().isISO8601({ strict: true }), query('to').optional().isISO8601({ strict: true }),
      query('company_id').optional().isUUID(), query('status').optional().isIn(['todo', 'in_progress', 'done'])),
    wrap(async (req: AuthRequest, res) => {
      res.json({ data: await adminCrm.listDeadlines(req.user!, req.query as any) });
    }));
  const kinds = ['variables', 'validation', 'payment', 'social', 'other'];
  r.post('/deadlines',
    rules(body('company_id').isUUID(), body('kind').isIn(kinds), body('title').trim().isLength({ min: 1, max: 255 }),
      body('due_date').isISO8601({ strict: true }), body('notes').optional({ values: 'falsy' }).isLength({ max: 2000 })),
    wrap(async (req: AuthRequest, res) => {
      res.status(201).json({ data: await adminCrm.createDeadline(req.user!, req.body) });
    }));
  r.put('/deadlines/:id',
    rules(uuid('id'), body('kind').optional().isIn(kinds), body('title').optional().trim().isLength({ min: 1, max: 255 }),
      body('due_date').optional().isISO8601({ strict: true }), body('status').optional().isIn(['todo', 'in_progress', 'done']),
      body('notes').optional({ values: 'null' }).isLength({ max: 2000 })),
    wrap(async (req: AuthRequest, res) => {
      const d = await adminCrm.updateDeadline(req.user!, req.params.id, req.body);
      if (!d) throw httpError(404, 'Échéance introuvable');
      res.json({ data: d });
    }));
  r.delete('/deadlines/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    if (!(await adminCrm.deleteDeadline(req.user!, req.params.id))) throw httpError(404, 'Échéance introuvable');
    res.json({ success: true });
  }));

  /* ---------- Documents ---------- */
  r.get('/documents', wrap(async (req: AuthRequest, res) => {
    res.json({ data: await adminCrm.listDocuments(req.user!, req.query as any) });
  }));
  r.post('/documents', upload.single('file') as unknown as RequestHandler,
    rules(body('title').trim().isLength({ min: 1, max: 255 }), body('company_id').optional({ values: 'falsy' }).isUUID(),
      body('category').optional({ values: 'falsy' }).isLength({ max: 100 }),
      body('description').optional({ values: 'falsy' }).isLength({ max: 2000 }),
      body('published').optional().isBoolean().toBoolean()),
    wrap(async (req: AuthRequest, res) => {
      const file = (req as any).file as { originalname: string; buffer: Buffer } | undefined;
      if (!file) throw httpError(400, 'Fichier manquant.');
      const doc = await adminCrm.createDocument(req.user!, {
        title: req.body.title, description: req.body.description, category: req.body.category,
        company_id: req.body.company_id || null, published: req.body.published ?? false,
      }, file);
      res.status(201).json({ data: doc });
    }));
  r.put('/documents/:id',
    rules(uuid('id'), body('title').optional().trim().isLength({ min: 1, max: 255 }), body('published').optional().isBoolean().toBoolean()),
    wrap(async (req: AuthRequest, res) => {
      const d = await adminCrm.updateDocument(req.user!, req.params.id, req.body);
      if (!d) throw httpError(404, 'Document introuvable');
      res.json({ data: d });
    }));
  r.delete('/documents/:id', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    if (!(await adminCrm.deleteDocument(req.user!, req.params.id))) throw httpError(404, 'Document introuvable');
    res.json({ success: true });
  }));
  r.get('/documents/:id/download', rules(uuid('id')), wrap(async (req: AuthRequest, res) => {
    const f = await adminCrm.getDocumentFile(req.user!, req.params.id);
    if (!f) throw httpError(404, 'Document introuvable');
    sendFile(res, f);
  }));

  return r;
}
