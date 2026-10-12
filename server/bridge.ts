import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { completion, ollamaHealthy } from './brain.js';
import type { ChatInput } from '../shared/types.js';

export function createBridge(token: string, origin: string, generate = completion, healthy = ollamaHealthy) {
  const app = express();
  app.disable('x-powered-by');
  const tokenHash = createHash('sha256').update(token).digest();
  app.use((req, res, next) => {
    if (req.headers.origin && req.headers.origin !== origin) return res.status(403).json({ reason: 'origin', message: 'This app is not paired with your laptop.' });
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pairing-Token, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const supplied = typeof req.headers['x-pairing-token'] === 'string' ? req.headers['x-pairing-token'] : '';
    if (!timingSafeEqual(tokenHash, createHash('sha256').update(supplied).digest())) return res.status(401).json({ reason: 'pairing', message: 'A valid pairing token is required.' });
    next();
  });
  let minute = 0, count = 0;
  app.use(express.json({ limit: '220kb' }));
  app.get('/health', (_req, res, next) => { void healthy().then(online => res.status(online ? 200 : 503).json({ online })).catch(next); });
  const textContent = z.object({ type: z.literal('text'), text: z.string().max(10_000) });
  const imageContent = z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(205_000).refine(v => Boolean(v.split(',')[1]) && Buffer.byteLength(v.split(',')[1], 'base64') <= 150_000) }) });
  const requestSchema = z.object({ messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string().min(1).max(10_000), z.array(z.union([textContent, imageContent])).min(1).max(3)]) })).min(1).max(5), vision: z.boolean().optional() });
  app.post('/v1/chat/completions', (req, res, next) => { void (async () => {
    const data = requestSchema.parse(req.body);
    const current = Math.floor(Date.now() / 60_000); if (minute !== current) { minute = current; count = 0; }
    if (count >= 30) throw new AppError(429, 'laptop_burst', 'Slow down, I am thinking!');
    count++;
    const line = await generate(data.messages as ChatInput[], 'local', data.vision === true);
    res.json({ choices: [{ message: { role: 'assistant', content: line } }] });
  })().catch(next); });
  app.use((_req, res) => res.status(404).json({ reason: 'not_found', message: 'This laptop route does not exist.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ reason: 'validation', message: 'Invalid brain request.' });
    if (error instanceof AppError) return res.status(error.status).json({ reason: error.reason, message: error.message });
    res.status((error as { status?: number }).status === 413 ? 413 : 500).json({ reason: 'bridge', message: 'The laptop could not process that request.' });
  });
  return app;
}
