import { z } from 'zod';
import type { Place } from '../shared/types.js';
import { geoCell } from '../shared/pet.js';
import type { Store, Row } from './store.js';

export const placeProviders = ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter'];
export const geoapifyUrl = 'https://api.geoapify.com/v2/places';
type Spot = Omit<Place, 'distanceM'>;
type Provider = 'geoapify' | 'overpass';
type Lookup = { places: Spot[]; provider: Provider | null; cacheHit: boolean; stale: boolean; unavailable: boolean };
const point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const payload = z.object({ remark: z.string().optional(), elements: z.array(z.object({ type: z.enum(['node', 'way', 'relation']), id: z.number().int().positive(), lat: z.number().optional(), lon: z.number().optional(), center: point.optional(), tags: z.record(z.string(), z.string()).optional() })) });
const geoapifyPayload = z.object({ type: z.literal('FeatureCollection'), features: z.array(z.object({
  properties: z.object({ place_id: z.string().min(1), name: z.string().optional(), categories: z.array(z.string()), lat: z.number().optional(), lon: z.number().optional(), datasource: z.object({ raw: z.object({ access: z.string().optional(), foot: z.string().optional() }).optional() }).optional() }),
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }).optional(),
})) });
const day = 86_400_000;

export function createPlaceLookup(store: Store, options: { fetch?: typeof fetch; now?: () => number; geoapifyKey?: string } = {}) {
  const request = options.fetch || fetch, now = options.now || Date.now;
  const providers = options.geoapifyKey ? [geoapifyUrl, ...placeProviders] : placeProviders;
  const source = (cached: Row): Provider => cached.provider === 'geoapify' ? 'geoapify' : 'overpass';
  const jobs = new Map<string, Promise<Lookup>>();
  const cooldown = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  const fallback = (cached: Row | null): Lookup => {
    const places: Spot[] = cached && cached.expiresAt > new Date(now()) ? cached.places || [] : [];
    return { places, provider: places.length && cached ? source(cached) : null, cacheHit: places.length > 0, stale: true, unavailable: true };
  };

  async function refresh(cell: string, cached: Row | null, allowRefresh: () => Promise<boolean>): Promise<Lookup> {
    if (providers.every(provider => (cooldown.get(provider) || 0) > now())) return fallback(cached);
    if (!await allowRefresh()) return fallback(cached);
    const [lat, lon] = cell.split(',').map(Number);
    const around = '(around:2200,' + lat + ',' + lon + ')';
    const publicAccess = '[access!~"^(private|no)$"][foot!=no]';
    const query = '[out:json][timeout:5];(nwr' + around + '[leisure~"^(park|garden|nature_reserve)$"]' + publicAccess + ';nwr' + around + '[natural=water]' + publicAccess + ';way' + around + '[highway=path]' + publicAccess + ';);out center 100;';
    for (const provider of providers) {
      if ((cooldown.get(provider) || 0) > now()) continue;
      try {
        const isGeoapify = provider === geoapifyUrl;
        const response = await request(provider, { method: 'POST', headers: { 'User-Agent': 'Pawpath/0.1 (outdoor companion game)', Accept: 'application/json', ...(isGeoapify ? { 'Content-Type': 'application/json', 'x-api-key': options.geoapifyKey! } : {}) }, body: isGeoapify ? JSON.stringify({ categories: ['leisure.park', 'natural.water', 'highway.path'], filter: { type: 'circle', lat, lon, radius: 2200 }, bias: { type: 'proximity', lat, lon }, limit: 20, lang: 'en' }) : new URLSearchParams({ data: query }), signal: AbortSignal.timeout(6500) });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Place provider unavailable'); }
        const json = await response.json();
        const spots = new Map<string, Spot>();
        if (isGeoapify) {
          const data = geoapifyPayload.parse(json);
          for (const feature of data.features) {
            const p = feature.properties, access = p.datasource?.raw;
            if (access?.access === 'private' || access?.access === 'no' || access?.foot === 'no') continue;
            const coords = point.safeParse({ lat: p.lat ?? feature.geometry?.coordinates[1], lon: p.lon ?? feature.geometry?.coordinates[0] });
            if (!coords.success) continue;
            const water = p.categories.some(c => c === 'natural.water' || c.startsWith('natural.water.'));
            const garden = p.categories.includes('leisure.park.garden'), trail = p.categories.includes('highway.path');
            const id = 'geoapify:' + p.place_id;
            spots.set(id, { id, name: p.name || (water ? 'A nearby waterside' : trail ? 'A nearby trail' : 'A nearby green space'), category: water ? 'water' : garden ? 'flower' : 'tree', ...coords.data });
          }
        } else {
          const data = payload.parse(json);
          if (data.remark) throw new Error('Incomplete place lookup');
          for (const el of data.elements) {
            if (el.tags?.access === 'private' || el.tags?.access === 'no' || el.tags?.foot === 'no') continue;
            const coords = point.safeParse(el.center || { lat: el.lat, lon: el.lon });
            if (!coords.success) continue;
            const id = el.type + ':' + el.id;
            spots.set(id, { id, name: el.tags?.name || (el.tags?.natural === 'water' ? 'A nearby waterside' : el.tags?.highway === 'path' ? 'A nearby trail' : 'A nearby green space'), category: el.tags?.natural === 'water' ? 'water' : el.tags?.leisure === 'garden' ? 'flower' : 'tree', ...coords.data });
          }
        }
        const places = [...spots.values()], providerName: Provider = isGeoapify ? 'geoapify' : 'overpass';
        await store.update('placesCache', { _id: cell }, { $set: { places, provider: providerName, freshUntil: new Date(now() + day), expiresAt: new Date(now() + 30 * day), retryAfter: new Date(0) } }, true);
        return { places, provider: providerName, cacheHit: false, stale: false, unavailable: false };
      } catch { cooldown.set(provider, now() + 60_000); }
    }
    await store.update('placesCache', { _id: cell }, { $set: { retryAfter: new Date(now() + 60_000) }, $setOnInsert: { places: [], freshUntil: new Date(0), expiresAt: new Date(now() + day) } }, true);
    return fallback(cached);
  }

  return async (lat: number, lon: number, allowRefresh: () => Promise<boolean> = async () => true): Promise<Lookup> => {
    const cell = geoCell(lat, lon), cached = await store.findOne('placesCache', { _id: cell });
    const legacyCache = Boolean(options.geoapifyKey && cached && !cached.provider);
    if (cached && !legacyCache && (cached.freshUntil || cached.expiresAt) > new Date(now())) return { places: cached.places, provider: source(cached), cacheHit: true, stale: false, unavailable: false };
    if (!legacyCache && cached?.retryAfter > new Date(now())) return fallback(cached);
    const existing = jobs.get(cell);
    if (existing) return existing;
    const queuedAt = now();
    const job = queue.then(() => now() - queuedAt > 5000 ? fallback(cached) : refresh(cell, cached, allowRefresh));
    jobs.set(cell, job);
    queue = job.catch(() => {});
    try { return await job; } finally { jobs.delete(cell); }
  };
}
