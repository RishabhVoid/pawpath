import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { ChatInput } from '../shared/types.js';

const photo = z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(205_000).refine(value => Boolean(value.split(',')[1]) && Buffer.byteLength(value.split(',')[1], 'base64') <= 150_000);
const part = z.discriminatedUnion('type', [z.object({ type: z.literal('text'), text: z.string().max(8000) }).strict(), z.object({ type: z.literal('image_url'), image_url: z.object({ url: photo }).strict() }).strict()]);
const input = z.object({ messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string().min(1).max(8000), z.array(part).min(1).max(2)]) }).strict()).min(1).max(5), vision: z.boolean() }).strict().refine(data => data.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content).filter(item => item.type === 'image_url').length <= (data.vision ? 1 : 0));
type Job = { id: string; userId: string; credential: string; hostId: string; messages?: ChatInput[]; vision: boolean; state: 'queued' | 'working' | 'done' | 'failed'; text?: string; expires: number; timer: ReturnType<typeof setTimeout> };
type Host = { id: string; credential: string; seen: number; waiter?: () => void; timer: ReturnType<typeof setTimeout> };

export function installBrowserHost(app: express.Express, now: () => number, reserve: (userId: string) => Promise<unknown>) {
  const hosts = new Map<string, Host>(), jobs = new Map<string, Job>();
  const route = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
  const identity = (res: Response) => ({ userId: res.locals.user._id as string, credential: res.locals.credential as string });
  function drop(userId: string) {
    const host = hosts.get(userId);
    if (!host) return;
    hosts.delete(userId); clearTimeout(host.timer); host.waiter?.();
    for (const job of jobs.values()) if (job.hostId === host.id && job.state !== 'done') { job.state = 'failed'; delete job.messages; }
  }
  function touch(userId: string, host: Host) {
    clearTimeout(host.timer); host.seen = now();
    host.timer = setTimeout(() => drop(userId), 45_000); host.timer.unref();
  }
  function active(userId: string) {
    const host = hosts.get(userId);
    if (host && now() - host.seen >= 45_000) { drop(userId); return undefined; }
    return host;
  }
  function ownHost(res: Response, id: string) {
    const { userId, credential } = identity(res), host = active(userId);
    if (!host || host.id !== id || host.credential !== credential) throw new AppError(404, 'host_missing', 'This browser is no longer hosting Gemma.');
    return host;
  }
  function prune() {
    for (const [id, job] of jobs) if (job.expires <= now()) { clearTimeout(job.timer); jobs.delete(id); }
    for (const userId of hosts.keys()) active(userId);
  }
  app.get('/api/ai/status', route((_req, res) => {
    const { userId, credential } = identity(res), host = active(userId);
    res.json({ online: Boolean(host), hostingHere: Boolean(host && host.credential === credential), hostId: host?.id || null, model: 'Gemma 4 E2B' });
  }));
  app.post('/api/ai/host', route(async (req, res) => {
    const { userId, credential } = identity(res); await reserve(userId); prune();
    const { hostId } = z.object({ hostId: z.string().uuid().optional() }).strict().parse(req.body);
    if (hostId) { const host = ownHost(res, hostId); touch(userId, host); return res.json({ hostId: host.id }); }
    const previous = active(userId);
    if (!previous && hosts.size >= 200) throw new AppError(503, 'host_capacity', 'Pawpath is busy. Try waking Gemma again shortly.');
    drop(userId);
    const host: Host = { id: randomUUID(), credential, seen: now(), timer: undefined! };
    hosts.set(userId, host); touch(userId, host); res.json({ hostId: host.id });
  }));
  app.get('/api/ai/host/:id/next', route(async (req, res) => {
    const { userId } = identity(res), host = ownHost(res, String(req.params.id));
    if (host.waiter) throw new AppError(409, 'host_polling', 'This host already has a waiting connection.');
    touch(userId, host); prune();
    const nextJob = () => [...jobs.values()].find(job => job.hostId === host.id && job.state === 'queued');
    if (!nextJob()) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); host.waiter = undefined; res.off('close', finish); resolve(); };
      const timer = setTimeout(finish, 20_000); timer.unref(); host.waiter = finish; res.once('close', finish);
    });
    if (res.destroyed) return;
    ownHost(res, host.id); touch(userId, host); prune();
    const job = nextJob();
    if (!job) return res.json({ job: null });
    job.state = 'working';
    const messages = job.messages; delete job.messages;
    res.json({ job: { id: job.id, messages, vision: job.vision } });
  }));
  app.delete('/api/ai/host/:id', route((req, res) => { ownHost(res, String(req.params.id)); drop(identity(res).userId); res.json({ stopped: true }); }));
  app.post('/api/ai/jobs', route(async (req, res) => {
    const data = input.parse(req.body), { userId, credential } = identity(res); await reserve(userId); prune();
    const host = active(userId);
    if (!host) throw new AppError(503, 'host_asleep', 'Wake Gemma on your laptop and keep that tab open.');
    if (jobs.size >= 300 || [...jobs.values()].filter(job => job.hostId === host.id && ['queued', 'working'].includes(job.state)).length >= 3) throw new AppError(429, 'host_busy', 'Your buddy is still thinking. Try again in a moment.');
    const id = randomUUID(), timer = setTimeout(() => jobs.delete(id), 120_000); timer.unref();
    jobs.set(id, { id, userId, credential, hostId: host.id, messages: data.messages, vision: data.vision, state: 'queued', expires: now() + 120_000, timer });
    host.waiter?.(); res.status(202).json({ id });
  }));
  app.post('/api/ai/host/:id/result', route((req, res) => {
    const host = ownHost(res, String(req.params.id));
    const data = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(4000).optional(), failed: z.literal(true).optional() }).strict().refine(value => Boolean(value.text) !== Boolean(value.failed)).parse(req.body);
    prune(); const job = jobs.get(data.id);
    if (!job || job.hostId !== host.id || job.state !== 'working') throw new AppError(409, 'job_changed', 'This request has already ended.');
    job.state = data.failed ? 'failed' : 'done'; job.text = data.text; res.json({ saved: true });
  }));
  app.get('/api/ai/jobs/:id', route((req, res) => {
    prune(); const { userId, credential } = identity(res), job = jobs.get(String(req.params.id));
    if (!job || job.userId !== userId || job.credential !== credential) throw new AppError(404, 'job_missing', 'This request has ended. Please try again.');
    active(userId);
    if (job.state === 'failed') { jobs.delete(job.id); clearTimeout(job.timer); throw new AppError(503, 'host_failed', 'Gemma stopped responding. Wake it again on your laptop.'); }
    res.json({ state: job.state, ...(job.state === 'done' ? { text: job.text } : {}) });
    if (job.state === 'done') { jobs.delete(job.id); clearTimeout(job.timer); }
  }));
  app.delete('/api/ai/jobs/:id', route((req, res) => {
    const { userId, credential } = identity(res), job = jobs.get(String(req.params.id));
    if (job?.userId === userId && job.credential === credential) { jobs.delete(job.id); clearTimeout(job.timer); }
    res.json({ cancelled: true });
  }));
  return { stopDevice: (userId: string, credential: string) => { if (hosts.get(userId)?.credential === credential) drop(userId); }, erase: (userId: string) => { drop(userId); for (const [id, job] of jobs) if (job.userId === userId) { jobs.delete(id); clearTimeout(job.timer); } } };
}
