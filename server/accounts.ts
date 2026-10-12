import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Store, Row } from './store.js';
import { AppError } from './errors.js';

const derive = promisify(scrypt);
export const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const usernameSchema = z.string().trim().toLowerCase().min(3).max(24).regex(/^[a-z][a-z0-9_]*$/, 'Use letters, numbers, and underscores. Start with a letter.');
const credentials = z.object({ username: usernameSchema, password: z.string().min(6, 'Use at least 6 characters.').max(128) }).strict();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

export async function accountFor(store: Store, token: string, now: number): Promise<Row | null> {
  if (!tokenSchema.safeParse(token).success) return null;
  const hash = credentialHash(token);
  const session = await store.findOne('sessions', { _id: hash });
  if (session && session.expiresAt > new Date(now)) return store.findOne('users', { _id: session.userId });
  return store.findOne('users', { tokenHash: hash });
}

async function newSession(store: Store, userId: string, now: number) {
  const token = randomBytes(32).toString('base64url');
  await store.insert('sessions', { _id: credentialHash(token), userId, expiresAt: new Date(now + 30 * 86_400_000) });
  return token;
}

export function phoneOrigin(origin: string) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError(400, 'handoff_url', 'Use your Pawpath web address.');
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address));
    if (!address) throw new AppError(422, 'handoff_network', 'Connect this computer and your phone to the same Wi-Fi, then try again.');
    url.hostname = address.address;
  }
  return url.origin;
}

export function installAccountRoutes(app: Express, store: Store, now: () => number) {
  const limit = (req: Request, kind: string, cap: number) => store.reserve(credentialHash(req.ip || 'local') + ':' + kind + ':' + Math.floor(now() / 60_000), cap, kind, new Date(now() + 120_000));
  app.post('/api/account/register', wrap(async (req, res) => {
    await limit(req, 'register', 5);
    const { username, password } = credentials.parse(req.body);
    const existing = await accountFor(store, req.headers.authorization?.replace(/^Bearer /, '') || '', now());
    if (existing?.username) throw new AppError(409, 'account_named', 'This account already has a username.');
    const userId = existing?._id || randomUUID();
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await derive(password, salt, 64) as Buffer).toString('hex');
    try { await store.insert('usernames', { _id: username, userId }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new AppError(409, 'username_taken', 'That username is taken. Try another.'); throw error; }
    try {
      const user = await store.update('users', { _id: userId, username: { $exists: false } }, { $set: { username, passwordHash, passwordSalt: salt }, $setOnInsert: { tokenHash: credentialHash(randomBytes(32).toString('base64url')), friendCode: randomBytes(5).toString('hex').toUpperCase(), createdAt: now() } }, true);
      if (!user) throw new AppError(409, 'account_named', 'This account already has a username.');
      const token = await newSession(store, userId, now());
      if (existing) await store.update('walks', { userId, endedAt: null, tracker: credentialHash(req.headers.authorization!.replace(/^Bearer /, '')) }, { $set: { tracker: credentialHash(token) } });
      res.status(201).json({ token, username, friendCode: user!.friendCode });
    } catch (error) { await store.remove('usernames', { _id: username, userId }); if ((error as { code?: number }).code === 11000) throw new AppError(409, 'account_named', 'This account already has a username.'); throw error; }
  }));
  app.post('/api/account/login', wrap(async (req, res) => {
    await limit(req, 'login', 5);
    const { username, password } = credentials.parse(req.body);
    const entry = await store.findOne('usernames', { _id: username });
    const user = entry ? await store.findOne('users', { _id: entry.userId }) : null;
    const expected = Buffer.from(user?.passwordHash || '00'.repeat(64), 'hex');
    const actual = await derive(password, user?.passwordSalt || 'missing-account-salt', 64) as Buffer;
    if (!user || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AppError(401, 'login', 'The username or password doesn’t match.');
    res.json({ token: await newSession(store, user._id, now()), username: user.username });
  }));
  app.post('/api/handoff/claim', wrap(async (req, res) => {
    await limit(req, 'handoff_claim', 10);
    const { code } = z.object({ code: tokenSchema }).strict().parse(req.body);
    const handoff = await store.update('handoffs', { _id: credentialHash(code), used: false, expiresAt: { $gte: new Date(now()) } }, { $set: { used: true } });
    if (!handoff) throw new AppError(410, 'handoff_expired', 'This QR has expired or was already used. Make a new one on your other device.');
    if (!await store.findOne('users', { _id: handoff.userId })) throw new AppError(410, 'handoff_expired', 'This account is no longer available.');
    const token = await newSession(store, handoff.userId, now());
    await store.update('walks', { userId: handoff.userId, endedAt: null }, { $set: { tracker: credentialHash(token) } });
    res.json({ token, preferences: handoff.preferences });
  }));
}
