import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { rules, wrap } from '../middleware/http.js';
import { contactsService } from '../services/contacts.service.js';

/** Formulaire de contact public : validé, limité en débit, anti-spam (honeypot). */
export function buildPublicRouter(opts: { rateLimitMax?: number } = {}) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: opts.rateLimitMax ?? 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de messages envoyés. Réessayez plus tard.' },
  });

  r.post('/contact', limiter,
    rules(
      body('name').trim().isLength({ min: 1, max: 255 }).withMessage('Nom requis'),
      body('email').isEmail().normalizeEmail().withMessage('E-mail invalide'),
      body('phone').optional({ values: 'falsy' }).isLength({ max: 50 }),
      body('message').trim().isLength({ min: 5, max: 5000 }).withMessage('Message requis'),
      body('consent').equals('true').withMessage('Le consentement est requis').bail().toBoolean()
    ),
    wrap(async (req, res) => {
      // Champ piège : un humain ne le remplit jamais. On répond OK sans rien enregistrer.
      if (req.body.website) {
        res.status(202).json({ success: true });
        return;
      }
      const { name, email, phone, message } = req.body;
      await contactsService.createPublic({ name, email, phone, message });
      res.status(201).json({ success: true });
    }));

  return r;
}
