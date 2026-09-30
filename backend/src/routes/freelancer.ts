import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { forbidden } from '../errors';
import { authenticate } from '../middleware/auth';
import { submitComplianceData } from '../services/compliance';

export const freelancerRouter = Router();
freelancerRouter.use(authenticate);

/** Freelancer reicht SV-Nummer, Steuer-ID und Geburtsdatum ein; erst nach erfolgreicher Validierung bewerbungsfähig. */
freelancerRouter.put('/me/compliance', (req, res, next) => {
  (async () => {
    const body = z.object({
      socialSecurityNumber: z.string().min(12).max(14), taxId: z.string().min(11).max(13), birthDate: z.coerce.date(),
    }).parse(req.body);
    const f = await prisma.freelancer.findUnique({ where: { userId: req.userId! } });
    if (!f) throw forbidden('Kein Freelancer-Profil');
    await submitComplianceData(f.id, body);
    res.status(204).end();
  })().catch(next);
});
