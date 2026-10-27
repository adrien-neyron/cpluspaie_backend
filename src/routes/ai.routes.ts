// routes/ai.routes.ts
import { Router } from 'express';
import { openai } from '../services/openai.service.js'; // wrapper pour OpenAI

const router = Router();

router.post('/analyse', async (req, res) => {
  const b = req.body ?? {};
  const txt = (v: unknown) => String(v ?? '').slice(0, 500);
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20).map(txt) : []);
  const ccn = txt(b.ccn), effectif = txt(b.effectif), secteur = txt(b.secteur);
  const typeContrats = list(b.typeContrats), objectifs = list(b.objectifs);
  const problemes = txt(b.problemes), priorite = txt(b.priorite);

  try {
    const prompt = `
    Tu es un expert RH/paie. 
    Analyse cette entreprise : 
    CCN: ${ccn}, Effectif: ${effectif}, Secteur: ${secteur}, 
    Types de contrats: ${typeContrats.join(', ')}, Objectifs: ${objectifs.join(', ')}, 
    Problèmes: ${problemes}, Priorité: ${priorite}.
    Donne des recommandations claires et synthétiques pour optimiser la paie et la conformité.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ result: completion.choices[0].message?.content });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI analysis failed' });
  }
});

export default router;
