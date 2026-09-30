import { Router } from 'express';
import { prisma } from '../db';

const VERSION = process.env.APP_VERSION ?? '1.0.0';

/** Öffentliche System-Routen (ohne Auth): Statusseite und Health-Check für das Monitoring. */
export const systemRouter = Router();

systemRouter.get('/', (_req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'GastroEvolution SmartShift-Swap API läuft einwandfrei.',
    version: VERSION,
    environment: process.env.NODE_ENV ?? 'development',
  });
});

/** Prüft die Datenbank tatsächlich (SELECT 1); bei Ausfall 503, damit Monitoring anschlägt. */
systemRouter.get('/health', async (_req, res) => {
  let database: 'connected' | 'disconnected' = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'disconnected';
  }
  res.status(database === 'connected' ? 200 : 503).json({
    status: database === 'connected' ? 'ok' : 'error',
    uptime: process.uptime(),
    timestamp: Date.now(),
    database,
  });
});
