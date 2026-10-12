import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Binary } from 'mongodb';
import { config } from './config.js';
import { AppError } from './errors.js';
import { type Store, type Row, localSimilarity } from './store.js';
import { completion, embed, localHealthy, parseVision } from './brain.js';
import { petPrompt, visionPrompt } from '../shared/prompt.js';
import { currentPet, clamp, walkReward, geoCell, distanceBetween } from '../shared/pet.js';
import { equipmentSlots, species, legacySpecies, type Pet, type Memory } from '../shared/types.js';
import { shopItems, shopState } from '../shared/shop.js';
import { matchCompanion, companionStory } from '../shared/onboarding.js';
import { createPlaceLookup } from './places.js';
import { accountFor, credentialHash, installAccountRoutes, phoneOrigin } from './accounts.js';
import { installBrowserHost } from './browser-host.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const category = z.enum(['bird', 'tree', 'flower', 'water', 'sky', 'other']);
const profileSchema = z.object({ nickname: z.string().trim().min(1).max(24), pace: z.enum(['starting', 'sometimes', 'often']), interest: z.enum(['plants', 'wildlife', 'water']), tone: z.enum(['gentle', 'playful', 'bold']) });
const coordinates = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) });
const destinationSchema = z.object({ name: z.string().trim().min(1).max(200), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();
const imageSchema = z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(205_000).refine(value => Boolean(value.split(',')[1]) && Buffer.byteLength(value.split(',')[1], 'base64') <= 150_000, 'Photo is too large');
const memorySchema = z.object({ text: z.string().trim().min(1).max(300), category, geoCell: z.string().regex(/^-?\d{1,3}\.\d{4},-?\d{1,3}\.\d{4}$/).optional(), image: imageSchema.optional() });
type Dependencies = { embed?: typeof embed; completion?: typeof completion; now?: () => number; placesFetch?: typeof fetch; geoapifyKey?: string };

export function createApp(store: Store, dependencies: Dependencies = {}) {
  const app = express();
  const embedding = dependencies.embed || embed;
  const generate = dependencies.completion || completion;
  const now = dependencies.now || Date.now;
  const nearby = createPlaceLookup(store, { now, fetch: dependencies.placesFetch, geoapifyKey: dependencies.geoapifyKey ?? config.geoapifyKey });
  app.disable('x-powered-by');
  app.set('trust proxy', config.production ? 1 : false);
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
  app.use(express.json({ limit: '230kb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
  const user = (res: Response) => res.locals.user as Row;
  const petFor = async (res: Response) => {
    const row = await store.findOne('pets', { userId: user(res)._id });
    if (!row) throw new AppError(404, 'pet_missing', 'Create a companion first.');
    return currentPet(row as Pet, now());
  };
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const reserve = (id: string, kind: string, cap: number, minute = false) => store.reserve(id + ':' + kind + ':' + (minute ? Math.floor(now() / 60_000) : day()), cap, kind, new Date(now() + (minute ? 120_000 : 172_800_000)));
  const cleanMemory = (row: Row) => ({ _id: row._id, petId: row.petId, text: row.text, category: row.category, geoCell: row.geoCell, createdAt: row.createdAt, embeddingStatus: row.embeddingStatus, score: row.score, ...(row.hasPhoto ? { hasPhoto: true } : {}) });
  const memoryJobs = new Map<string, Promise<void>>();
  function prepareMemory(row: Row): Promise<void> {
    const existing = memoryJobs.get(row._id);
    if (existing) return existing.then(() => prepareMemory(row));
    const job = (async () => {
      try {
        const vector = await embedding(row.text);
        if (await store.findOne('pets', { _id: row.petId })) await store.update('memories', { _id: row._id, petId: row.petId, text: row.text }, { $set: { embedding: vector, embeddingModel: config.embeddingModel, embeddingStatus: 'ready' } });
      } catch {
        try { await store.update('memories', { _id: row._id, petId: row.petId, text: row.text }, { $set: { embeddingStatus: 'unavailable' } }); } catch { console.info('A saved memory is waiting for recall setup.'); }
      } finally { memoryJobs.delete(row._id); }
    })();
    memoryJobs.set(row._id, job);
    return job;
  }
  async function memoriesFor(pet: Pet, text: string) {
    const available = await store.find('memories', { petId: pet._id, embeddingStatus: 'ready' }, 500);
    if (!available.length) return [];
    let vector: number[];
    try { vector = await embedding(text); }
    catch { console.info('Memory recall is unavailable; continuing with the companion profile.'); return []; }
    try { return await store.vector(pet._id, vector) as unknown as Memory[]; }
    catch {
      store.vectorReady = false;
      return localSimilarity(available, vector) as unknown as Memory[];
    }
  }
  async function saveMemory(pet: Pet, data: z.infer<typeof memorySchema>, id = randomUUID()): Promise<Row> {
    const existing = await store.findOne('memories', { _id: id, petId: pet._id });
    if (existing) return existing;
    const rounded = data.geoCell ? data.geoCell.split(',').map(Number) : null;
    if (rounded) coordinates.parse({ lat: rounded[0], lon: rounded[1] });
    await store.reserve('memory:' + pet._id, 500, 'memory', new Date('2100-01-01'));
    const { image, ...note } = data;
    const row: Row = { _id: id, petId: pet._id, ...note, ...(image ? { hasPhoto: true } : {}), ...(rounded ? { geoCell: geoCell(rounded[0], rounded[1]) } : {}), createdAt: now(), embeddingStatus: 'pending' };
    let reservedPhoto = false;
    try {
      if (image) {
        try { await store.reserve('photo:' + pet._id, 50, 'photos', new Date('2100-01-01')); }
        catch (error) { if (error instanceof AppError && error.status === 429) throw new AppError(429, 'photo_limit', 'Your 50 photo slots are full. Turn off Keep photos to save more discovery notes.'); throw error; }
        reservedPhoto = true;
        const bytes = Buffer.from(image.split(',')[1], 'base64');
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new AppError(400, 'photo_format', 'Choose a JPEG photo.');
        await store.insert('memoryPhotos', { _id: id, petId: pet._id, bytes });
      }
      await store.insert('memories', row);
    }
    catch (error) {
      if (reservedPhoto) {
        await store.remove('memoryPhotos', { _id: id, petId: pet._id });
        await store.update('usageCounters', { _id: 'photo:' + pet._id }, { $inc: { count: -1 } });
      }
      await store.update('usageCounters', { _id: 'memory:' + pet._id }, { $inc: { count: -1 } });
      if ((error as { code?: number }).code === 11000) { const saved = await store.findOne('memories', { _id: id, petId: pet._id }); if (saved) return saved; }
      throw error;
    }
    void prepareMemory(row);
    return row;
  }
  app.get('/api/health', asyncRoute(async (_req, res) => res.json({ storage: store.kind, localBrain: await localHealthy(), vectorReady: store.vectorReady })));
  installAccountRoutes(app, store, now);
  app.post('/api/account', asyncRoute(async (req, res) => {
    await store.reserve(hash(req.ip || 'local') + ':signup:' + Math.floor(now() / 3_600_000), 5, 'signup', new Date(now() + 7_200_000));
    const token = randomBytes(32).toString('base64url');
    const row = { _id: randomUUID(), tokenHash: hash(token), friendCode: randomBytes(5).toString('hex').toUpperCase(), createdAt: now() };
    await store.insert('users', row);
    res.status(201).json({ token, friendCode: row.friendCode });
  }));
  app.use('/api', (req, res, next) => { void (async () => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, 'unauthorized', 'Your device session has expired. Please start again.');
    const account = await accountFor(store, token, now());
    if (!account) throw new AppError(401, 'unauthorized', 'Your device session has expired. Please start again.');
    res.locals.user = account; res.locals.credential = credentialHash(token);
  })().then(() => next()).catch(next); });
  return finishRoutes(app, store, { asyncRoute, user, petFor, day, reserve, saveMemory, prepareMemory, memoriesFor, cleanMemory, generate, now, nearby });
}

type Helpers = Record<string, any>;
function finishRoutes(app: express.Express, store: Store, h: Helpers) {
  const { asyncRoute, user, petFor, day, reserve, saveMemory, prepareMemory, memoriesFor, cleanMemory, generate, now } = h;
  const nearby: ReturnType<typeof createPlaceLookup> = h.nearby;
  const browserHosts = installBrowserHost(app, now, (id) => reserve(id, 'browser-ai', 20, true));
  app.get('/api/me', asyncRoute(async (_req: Request, res: Response) => res.json({ username: user(res).username || null, friendCode: user(res).friendCode, profile: user(res).profile || null })));
  const completeSetup = asyncRoute(async (req: Request, res: Response) => {
    const { profile, name } = z.object({ profile: profileSchema, name: z.string().trim().min(1).max(24) }).parse(req.body);
    const account = user(res);
    const existing = await store.findOne('pets', { userId: account._id });
    if (req.method === 'POST' && account.profile && existing) return res.json({ pet: currentPet(existing as Pet, now()), profile: account.profile });
    if (await store.findOne('walks', { userId: account._id, endedAt: null })) throw new AppError(409, 'walk_active', 'Finish your walk before matching your companion.');
    const { nickname: _nickname, ...companion } = profile;
    const pet = await store.update('pets', { _id: account._id }, { $set: { name, species: matchCompanion(profile).species, companion }, $setOnInsert: { userId: account._id, hunger: 65, mood: 80, energy: 90, xp: 0, level: 1, points: 0, ownedItems: [], equippedItems: {}, wardrobeVersion: 0, traits: [], rewardedWalkIds: [], updatedAt: now() } }, true);
    await store.update('users', { _id: account._id }, { $set: { profile } });
    const bond = await store.update('memories', { _id: 'bond:' + account._id }, { $set: { petId: account._id, kind: 'bond', text: companionStory(profile).memory, category: 'other', createdAt: now(), embeddingStatus: 'pending' } }, true);
    void prepareMemory(bond);
    res.status(existing ? 200 : 201).json({ pet: currentPet(pet as Pet, now()), profile });
  });
  app.post('/api/onboarding', completeSetup);
  app.put('/api/onboarding', completeSetup);
  const walkView = (walk: Row | null, credential: string) => {
    if (!walk) return null;
    const { tracker, ...data } = walk;
    return { ...data, trackingHere: !tracker || tracker === credential };
  };
  const getPetState = async (res: Response) => {
    const pet = await store.findOne('pets', { userId: user(res)._id });
    return { pet: pet ? currentPet(pet as Pet, now()) : null, walk: walkView(await store.findOne('walks', { userId: user(res)._id, endedAt: null }), res.locals.credential) };
  };
  app.get('/api/pet', asyncRoute(async (_req: Request, res: Response) => res.json(await getPetState(res))));
  app.get('/api/sync', asyncRoute(async (_req: Request, res: Response) => {
    const account = await store.findOne('users', { _id: user(res)._id });
    const state = await getPetState(res);
    const memories = state.pet ? (await store.find('memories', { petId: state.pet._id, kind: { $ne: 'bond' } }, 500)).map(cleanMemory) : [];
    res.json({ ...state, username: account?.username || null, profile: account?.profile || null, memories });
  }));
  app.post('/api/account/logout', asyncRoute(async (_req: Request, res: Response) => {
    browserHosts.stopDevice(user(res)._id, res.locals.credential);
    await store.remove('sessions', { _id: res.locals.credential });
    await store.update('users', { _id: user(res)._id, tokenHash: res.locals.credential }, { $set: { tokenHash: credentialHash(randomBytes(32).toString('base64url')) } });
    res.json({ signedOut: true });
  }));
  app.post('/api/handoff', asyncRoute(async (req: Request, res: Response) => {
    await reserve(user(res)._id, 'handoff', 5, true);
    const draft = profileSchema.partial().extend({ nickname: z.string().max(24).optional(), petName: z.string().max(24).optional(), step: z.number().int().min(0).max(4).optional() });
    const preferences = z.object({ mode: z.enum(['browser', 'host', 'laptop']), muted: z.boolean(), keepPhotos: z.boolean().optional(), tab: z.enum(['companion', 'journal', 'friends', 'shop', 'settings']), line: z.string().max(1000), setup: draft.optional(), welcome: z.boolean(), editing: z.boolean(), pairingLink: z.string().max(3000).optional(), journey: z.object({ destination: destinationSchema.optional() }).strict().optional() }).strict();
    const data = z.object({ origin: z.string().url(), preferences }).strict().parse(req.body);
    const origin = phoneOrigin(data.origin);
    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now() + 120_000);
    await store.insert('handoffs', { _id: credentialHash(code), userId: user(res)._id, preferences: data.preferences, used: false, expiresAt });
    res.json({ url: origin + '/#continue=' + code, expiresAt: expiresAt.getTime() });
  }));
  app.post('/api/handoff/status', asyncRoute(async (req: Request, res: Response) => {
    const { code } = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(req.body);
    const row = await store.findOne('handoffs', { _id: credentialHash(code), userId: user(res)._id });
    if (!row) throw new AppError(404, 'handoff_missing', 'Make a new code to continue.');
    res.json({ used: row.used, expiresAt: row.expiresAt.getTime() });
  }));
  const progressSchema = z.object({ walkId: z.string().uuid(), distanceM: z.number().min(0).max(100_000), geoCells: z.array(z.string().regex(/^-?\d{1,3}\.\d{4},-?\d{1,3}\.\d{4}$/)).max(1000) });
  app.post('/api/walk/progress', asyncRoute(async (req: Request, res: Response) => {
    const data = progressSchema.parse(req.body);
    const walk = await store.findOne('walks', { _id: data.walkId, userId: user(res)._id, endedAt: null });
    if (!walk || (walk.tracker && walk.tracker !== res.locals.credential)) throw new AppError(409, 'walk_elsewhere', 'This walk is continuing on your other device.');
    const distanceM = Math.min(Math.max(walk.distanceM, data.distanceM), Math.max(0, now() - walk.startedAt) / 1000 * 4);
    const geoCells = [...new Set([...walk.geoCells, ...data.geoCells.map(cell => { const [lat, lon] = cell.split(',').map(Number); coordinates.parse({ lat, lon }); return geoCell(lat, lon); })])].slice(0, 1000);
    const saved = await store.update('walks', { _id: walk._id, endedAt: null, tracker: walk.tracker ?? { $exists: false }, distanceM: walk.distanceM }, { $set: { distanceM, geoCells, tracker: res.locals.credential } });
    if (!saved) throw new AppError(409, 'walk_changed', 'Your walk changed on another device. Refresh to continue.');
    res.json({ walk: walkView(saved, res.locals.credential) });
  }));
  app.post('/api/walk/resume', asyncRoute(async (_req: Request, res: Response) => {
    const walk = await store.update('walks', { userId: user(res)._id, endedAt: null }, { $set: { tracker: res.locals.credential } });
    if (!walk) throw new AppError(404, 'walk_missing', 'There isn’t an active walk to continue.');
    res.json({ walk: walkView(walk, res.locals.credential) });
  }));
  app.post('/api/pet', asyncRoute(async (req: Request, res: Response) => {
    const data = z.object({ name: z.string().trim().min(1).max(24), species: z.enum([...species, ...legacySpecies]) }).parse(req.body);
    const pet = await store.update('pets', { _id: user(res)._id }, { $setOnInsert: { userId: user(res)._id, ...data, hunger: 65, mood: 80, energy: 90, xp: 0, level: 1, points: 0, ownedItems: [], equippedItems: {}, wardrobeVersion: 0, traits: [], rewardedWalkIds: [], updatedAt: now() } }, true);
    res.status(201).json({ pet: currentPet(pet as Pet, now()) });
  }));
  app.get('/api/shop', asyncRoute(async (_req: Request, res: Response) => res.json(shopState(await petFor(res)))));
  const wardrobeFilter = (pet: Pet) => ({ _id: pet._id, userId: pet.userId, wardrobeVersion: pet.wardrobeVersion ?? { $exists: false } });
  app.post('/api/shop/purchase', asyncRoute(async (req: Request, res: Response) => {
    const { itemId } = z.object({ itemId: z.string() }).strict().parse(req.body);
    const item = shopItems.find(item => item.id === itemId);
    if (!item) throw new AppError(404, 'item_missing', 'That item is not in the shop.');
    for (let attempt = 0; attempt < 5; attempt++) {
      const pet: Pet = await petFor(res);
      if (pet.ownedItems?.includes(item.id)) return res.json(shopState(pet));
      if ((pet.points || 0) < item.price) throw new AppError(422, 'points_needed', 'You need ' + (item.price - (pet.points || 0)) + ' more points for this.');
      const saved = await store.update('pets', { ...wardrobeFilter(pet), ...(item.price ? { points: { $gte: item.price } } : {}) }, {
        $inc: { points: -item.price, wardrobeVersion: 1 },
        $set: { equippedItems: { ...pet.equippedItems, [item.slot]: item.id } },
        $addToSet: { ownedItems: item.id },
      });
      if (saved) return res.json(shopState(currentPet(saved as Pet, now())));
    }
    throw new AppError(409, 'wardrobe_busy', 'Your outfit is changing. Try again.');
  }));
  app.post('/api/shop/equip', asyncRoute(async (req: Request, res: Response) => {
    const { itemId, slot } = z.object({ itemId: z.string().nullable(), slot: z.enum(equipmentSlots) }).strict().parse(req.body);
    const item = itemId === null ? null : shopItems.find(item => item.id === itemId);
    if (itemId !== null && (!item || item.slot !== slot)) throw new AppError(400, 'item_slot', 'Choose an item for this outfit slot.');
    for (let attempt = 0; attempt < 5; attempt++) {
      const pet: Pet = await petFor(res);
      if (item && !pet.ownedItems?.includes(item.id)) throw new AppError(403, 'item_unowned', 'Get this item before wearing it.');
      const equippedItems = { ...pet.equippedItems };
      if (item) equippedItems[slot] = item.id; else delete equippedItems[slot];
      const saved = await store.update('pets', wardrobeFilter(pet), { $set: { equippedItems }, $inc: { wardrobeVersion: 1 } });
      if (saved) return res.json(shopState(currentPet(saved as Pet, now())));
    }
    throw new AppError(409, 'wardrobe_busy', 'Your outfit is changing. Try again.');
  }));
  app.post('/api/walk/start', asyncRoute(async (req: Request, res: Response) => {
    const { destination } = z.object({ destination: destinationSchema.optional() }).strict().parse(req.body || {});
    const pet = await petFor(res);
    const existing = await store.findOne('walks', { userId: user(res)._id, endedAt: null });
    if (existing) return res.json({ walk: walkView(existing, res.locals.credential) });
    const walk = { _id: randomUUID(), userId: user(res)._id, petId: pet._id, tracker: res.locals.credential, startedAt: now(), endedAt: null, distanceM: 0, geoCells: [], ...(destination ? { destination } : {}) };
    try { await store.insert('walks', walk); } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; return res.json({ walk: walkView(await store.findOne('walks', { userId: user(res)._id, endedAt: null }), res.locals.credential) }); }
    res.status(201).json({ walk: walkView(walk, res.locals.credential) });
  }));
  app.post('/api/walk/end', asyncRoute(async (req: Request, res: Response) => {
    const data = z.object({ walkId: z.string().uuid(), distanceM: z.number().min(0).max(100_000), geoCells: z.array(z.string().regex(/^-?\d{1,3}\.\d{4},-?\d{1,3}\.\d{4}$/)).max(1000) }).parse(req.body);
    const account = user(res);
    let walk = await store.findOne('walks', { _id: data.walkId, userId: account._id });
    if (!walk) throw new AppError(404, 'walk_missing', 'This walk was not found.');
    if (walk.endedAt === null && walk.tracker && walk.tracker !== res.locals.credential) throw new AppError(409, 'walk_elsewhere', 'This walk is continuing on your other device.');
    const distanceM = Math.min(Math.max(data.distanceM, walk.distanceM), Math.max(0, now() - walk.startedAt) / 1000 * 4);
    if (walk.endedAt === null) {
      const roundedCells = data.geoCells.map(cell => { const [lat, lon] = cell.split(',').map(Number); coordinates.parse({ lat, lon }); return geoCell(lat, lon); });
      walk = await store.update('walks', { _id: walk._id, userId: account._id, endedAt: null, tracker: walk.tracker ?? { $exists: false } }, { $set: { endedAt: now(), distanceM, geoCells: [...new Set([...walk.geoCells, ...roundedCells])].slice(0, 1000) } }) || await store.findOne('walks', { _id: data.walkId, userId: account._id });
    }
    const pet = await petFor(res);
    if (walk!.endedAt === null) throw new AppError(409, 'walk_elsewhere', 'This walk is continuing on your other device.');
    const reward = walkReward(walk!.distanceM);
    const completed = reward.xp > 0;
    await store.update('pets', { _id: pet._id, userId: account._id, rewardedWalkIds: { $ne: data.walkId } }, { $inc: { xp: reward.xp }, $set: { hunger: clamp(pet.hunger + (completed ? reward.food : 0)), mood: completed ? clamp(pet.mood + 15) : Math.min(pet.mood, 35), energy: clamp(pet.energy - walk!.distanceM / 150), updatedAt: now(), ...(completed ? { lastWalkAt: walk!.endedAt } : {}) }, $addToSet: { rewardedWalkIds: data.walkId } });
    let memoryWarning: string | undefined;
    if (completed) {
      try { await saveMemory(pet, { text: 'We walked ' + (walk!.distanceM / 1000).toFixed(2) + ' km together.', category: 'other', geoCell: walk!.geoCells[0] }, 'walk:' + walk!._id); } catch { memoryWarning = 'Walk saved. Memory storage is currently full or unavailable.'; }
    }
    res.json({ pet: await petFor(res), walk: walkView(walk, res.locals.credential), reward, memoryWarning });
  }));
  app.get('/api/memory', asyncRoute(async (_req: Request, res: Response) => { const pet = await petFor(res); res.json({ memories: (await store.find('memories', { petId: pet._id, kind: { $ne: 'bond' } }, 500)).map(cleanMemory) }); }));
  app.get('/api/memory/:id/photo', asyncRoute(async (req: Request, res: Response) => {
    const pet = await petFor(res);
    const saved = await store.findOne('memoryPhotos', { _id: String(req.params.id), petId: pet._id });
    if (!saved) throw new AppError(404, 'photo_missing', 'This photo is no longer available.');
    const bytes = saved.bytes instanceof Binary ? Buffer.from(saved.bytes.value()) : Buffer.from(saved.bytes);
    res.type('image/jpeg').send(bytes);
  }));
  app.post('/api/memory', asyncRoute(async (req: Request, res: Response) => { const pet = await petFor(res); await reserve(user(res)._id, 'memory_burst', 10, true); res.status(201).json({ memory: cleanMemory(await saveMemory(pet, memorySchema.parse(req.body))) }); }));
  app.post('/api/memory/retry', asyncRoute(async (_req: Request, res: Response) => {
    const pet = await petFor(res);
    await reserve(user(res)._id, 'memory_retry', 2, true);
    const rows = await store.find('memories', { petId: pet._id, embeddingStatus: { $ne: 'ready' } }, 20);
    for (const row of rows) await prepareMemory(row);
    res.json({ retried: rows.length });
  }));
  app.delete('/api/memory', asyncRoute(async (_req: Request, res: Response) => { const pet = await petFor(res); await store.remove('memories', { petId: pet._id }); await store.remove('memoryPhotos', { petId: pet._id }); await store.remove('usageCounters', { _id: 'memory:' + pet._id }); await store.remove('usageCounters', { _id: 'photo:' + pet._id }); res.json({ count: 0 }); }));
  const chatSchema = z.object({ text: z.string().trim().min(1).max(500) });
  app.post('/api/context', asyncRoute(async (req: Request, res: Response) => { const pet = await petFor(res); const { text } = chatSchema.parse(req.body); await reserve(user(res)._id, 'context', 30, true); const memories = await memoriesFor(pet, text); res.json({ messages: [{ role: 'system', content: petPrompt(pet, memories) }, { role: 'user', content: text }], memories: memories.map(cleanMemory) }); }));
  if (!config.production) {
    app.post('/api/local/chat', asyncRoute(async (req: Request, res: Response) => {
      const pet = await petFor(res), { text } = chatSchema.parse(req.body);
      await reserve(user(res)._id, 'local_burst', 30, true);
      const memories = await memoriesFor(pet, text);
      res.json({ line: await generate([{ role: 'system', content: petPrompt(pet, memories) }, { role: 'user', content: text }], 'local'), mode: 'laptop', memories: memories.map(cleanMemory) });
    }));
    app.post('/api/local/vision', asyncRoute(async (req: Request, res: Response) => {
      const pet = await petFor(res);
      const { image, keepPhoto } = z.object({ image: imageSchema, keepPhoto: z.boolean().optional() }).parse(req.body);
      await reserve(user(res)._id, 'local_vision', 30, true);
      const result = parseVision(await generate([{ role: 'user', content: [{ type: 'text', text: visionPrompt }, { type: 'image_url', image_url: { url: image } }] }], 'local', true));
      if (result.is_outdoor && !result.is_screen) await saveMemory(pet, { text: result.label, category: result.category, ...(keepPhoto ? { image } : {}) });
      res.json({ result });
    }));
  }
  app.get('/api/usage', asyncRoute(async (_req: Request, res: Response) => { const id = user(res)._id; const count = async (kind: string) => (await store.findOne('usageCounters', { _id: id + ':' + kind + ':' + day() }))?.count || 0; res.json({ places: await count('places'), placesLimit: 30 }); }));
  app.post('/api/friends', asyncRoute(async (req: Request, res: Response) => {
    await reserve(user(res)._id, 'friend_add', 10, true);
    const { code } = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-F0-9]{10}$/) }).parse(req.body);
    const other = await store.findOne('users', { friendCode: code });
    if (!other) throw new AppError(404, 'friend_missing', 'No companion has that friend code. Check the code and try again.');
    if (other._id === user(res)._id) throw new AppError(400, 'friend_self', 'That is your own friend code. Share it with someone else!');
    const ids = [other._id, user(res)._id].sort();
    await store.update('friendships', { _id: ids.join(':') }, { $setOnInsert: { users: ids, createdAt: now() } }, true);
    res.json({ added: true });
  }));
  app.get('/api/friends', asyncRoute(async (_req: Request, res: Response) => {
    const rows = await store.find('friendships', { users: user(res)._id }, 100);
    const friends = await Promise.all(rows.map(async row => { const other = row.users.find((id: string) => id !== user(res)._id); const pet = await store.findOne('pets', { userId: other }); if (!pet) return null; const p = currentPet(pet as Pet, now()); return { id: other, name: p.name, species: p.species, level: p.level, traits: p.traits, equippedItems: p.equippedItems || {} }; }));
    res.json({ friends: friends.filter(Boolean) });
  }));
  app.get('/api/places', asyncRoute(async (req: Request, res: Response) => {
    const pet = await petFor(res), point = coordinates.parse(req.query);
    const result = await nearby(point.lat, point.lon, async () => {
      try { await reserve(user(res)._id, 'places', 30); return true; }
      catch (error) { if (error instanceof AppError && error.reason === 'places') return false; throw error; }
    });
    const places = result.places.map(p => ({ ...p, distanceM: distanceBetween(point, p) })).filter(p => p.distanceM <= 2000).sort((a, b) => a.distanceM - b.distanceM);
    const seen = new Set((await store.find('memories', { petId: pet._id }, 500)).map(m => m.category));
    const suggestion = places.find(p => !seen.has(p.category)) || places[0] || null;
    res.json({ places, suggestion, provider: result.provider, cacheHit: result.cacheHit, stale: result.stale && places.length > 0, availability: places.length ? 'ready' : result.unavailable ? 'unavailable' : 'empty', seenCategories: [...seen] });
  }));
  app.delete('/api/account', asyncRoute(async (_req: Request, res: Response) => {
    browserHosts.erase(user(res)._id);
    const id = user(res)._id, pet = await store.findOne('pets', { userId: id });
    await store.remove('users', { _id: id });
    await store.remove('sessions', { userId: id }); await store.remove('handoffs', { userId: id }); await store.remove('usernames', { userId: id });
    await store.remove('pets', { userId: id }); await store.remove('walks', { userId: id }); await store.remove('friendships', { users: id });
    if (pet) { await store.remove('memories', { petId: pet._id }); await store.remove('memoryPhotos', { petId: pet._id }); await store.remove('usageCounters', { _id: 'memory:' + pet._id }); await store.remove('usageCounters', { _id: 'photo:' + pet._id }); }
    await store.remove('usageCounters', { owner: id });
    res.json({ deleted: true });
  }));
  app.use('/api', (_req, res) => res.status(404).json({ reason: 'not_found', message: 'This route was not found.' }));
  if (config.production) {
    app.use(express.static(resolve('client/dist')));
    app.use('/assets', (_req, res) => res.status(404).end());
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('client/dist/index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ reason: 'validation', message: 'Check the details and try again.' });
    if (error instanceof AppError) return res.status(error.status).json({ reason: error.reason, message: error.message, suggestMode: error.suggestMode });
    if ((error as { type?: string }).type === 'entity.too.large') return res.status(413).json({ reason: 'photo_size', message: 'That photo is too large. Try a smaller image.' });
    if ((error as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ reason: 'invalid_json', message: 'Something went wrong sending that request. Please try again.' });
    console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(500).json({ reason: 'internal', message: 'Something went wrong. Please try again.' });
  });
  return app;
}
