import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { HttpError } from './errors';
import path from 'path';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { integrationRouter } from './routes/integration';
import { restaurantRouter } from './routes/restaurants';
import { freelancerRouter } from './routes/freelancer';
import { systemRouter } from './routes/system';
import { marketplaceRouter } from './routes/marketplace';

/** Rate-Limits; für automatische Tests per API_RATE_LIMIT anhebbar (überschreibt die Standardwerte). */
const API_LIMIT = (dflt: number) => Number(process.env.API_RATE_LIMIT ?? dflt);

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // hinter nginx: echte Client-IP für Rate-Limits
  app.use(helmet());
  // Nur der Dokument-Upload darf größer sein (Base64 von max. 5 MB); vor dem globalen Parser mounten
  app.use('/api/v1/freelancers/me/hygiene-certificate', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '50kb' }));
  // Weboberfläche für Gastronomen (statisch, CSP-konform ohne Inline-Skripte)
  app.use('/app', express.static(path.resolve(process.cwd(), 'public'), { index: 'index.html', maxAge: '5m' }));
  app.use('/jobs', express.static(path.resolve(process.cwd(), 'public/jobs'), { index: 'index.html', maxAge: '5m' })); // Aushilfen-App (PWA)
  app.use(systemRouter); // GET / und GET /health – vor den API-Routen, ohne Rate-Limit
  app.use('/api/v1/marketplace', rateLimit({ windowMs: 60_000, limit: API_LIMIT(120) }), marketplaceRouter);

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/admin', rateLimit({ windowMs: 60_000, limit: API_LIMIT(120) }), adminRouter);
  app.use('/api/v1/restaurants', rateLimit({ windowMs: 60_000, limit: API_LIMIT(60) }), restaurantRouter);
  app.use('/api/v1/integrations', rateLimit({ windowMs: 60_000, limit: API_LIMIT(300) }), integrationRouter);
  app.use('/api/v1/freelancers', rateLimit({ windowMs: 60_000, limit: API_LIMIT(180) }), freelancerRouter); // Mobilfunknetze teilen sich oft eine IP; Registrierung/Upload haben eigene, strengere Limits

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof ZodError) return res.status(400).json({ error: 'VALIDATION', issues: err.issues });
    // Prisma: Serialization-Konflikt (P2034) bei gleichzeitigem Accept → Client kann erneut versuchen
    if ((err as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'CONFLICT', message: 'Gleichzeitige Änderung, bitte erneut versuchen' });
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'Interner Fehler' });
  });
  return app;
}
