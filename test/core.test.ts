import test from 'node:test';
import { matchCompanion, paceOptions, interestOptions, toneOptions } from '../shared/onboarding.js';
import { species } from '../shared/types.js';
import assert from 'node:assert/strict';
import { inject } from 'light-my-request';
import { createApp } from '../server/app.js';
import { createBridge } from '../server/bridge.js';
import { DevelopmentStore, type Row } from '../server/store.js';
import { currentPet, geoCell, levelFor, walkReward } from '../shared/pet.js';
import { completion, parseVision } from '../server/brain.js';
import { readVision } from '../shared/vision.js';
import { acceptedStep, keepWalkAwake, locate, watchWalk } from '../client/src/lib/walk.js';
import { isHandheld } from '../client/src/lib/device.js';
import { destinationMap, walkingDirections } from '../client/src/JourneyMap.js';
import { placePrompt, readPlaceChoice } from '../shared/places.js';
import { createPlaceLookup, geoapifyUrl, placeProviders } from '../server/places.js';
import { browserSupport, GemmaClient } from '../client/src/lib/browser-ai.js';
import { cachedModelFetch, gemmaModelId, gemmaRevision, deleteDownloadedModel, hasDownloadedModel, hasInstalledModel } from '../client/src/lib/model-cache.js';
import { config, resolveOllamaUrl } from '../server/config.js';
import { api, ApiError } from '../client/src/lib/api.js';
import { Binary } from 'mongodb';

config.production = false;

test('API rejects a hosting wake-up HTML page instead of treating it as saved account data', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  try {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>Waking up</html>', { headers: { 'Content-Type': 'text/html' } }));
    await assert.rejects(api('/health'), error => error instanceof ApiError && error.status === 503 && /waking up/.test(error.message));
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as any).localStorage; }
});

function fixture(embedding?: (text: string) => Promise<number[]>, placesFetch?: typeof fetch, geoapifyKey = '') {
  const store = new DevelopmentStore();
  let time = Date.UTC(2026, 9, 10, 12);
  const vector = embedding || (async (_text: string) => [1, ...Array(383).fill(0)]);
  const app = createApp(store, { now: () => time, embed: vector, placesFetch, geoapifyKey, completion: async (_messages, _mode, vision) => vision ? JSON.stringify({ is_outdoor: true, category: 'flower', label: 'A yellow flower by the path', is_screen: false }) : 'A little sunshine and a little company make a wonderful day.' });
  const request = (method: string, url: string, payload?: unknown, token?: string) => inject(app as any, { method: method as any, url, ...(payload ? { payload } : {}), headers: token ? { authorization: 'Bearer ' + token } : {} });
  const account = async (name = 'Mochi') => { const created = await request('POST', '/api/account', {}); assert.equal(created.statusCode, 201); const { token, friendCode } = created.json(); const pet = await request('POST', '/api/pet', { name, species: 'fox' }, token); assert.equal(pet.statusCode, 201); return { token, friendCode, pet: pet.json().pet }; };
  return { store, request, account, advance: (ms: number) => { time += ms; } };
}

test('development can reach a GPU laptop by IP, with explicit Ollama URLs taking precedence', () => {
  assert.equal(resolveOllamaUrl({ IP: '192.168.1.9' }), 'http://192.168.1.9:11434');
  assert.equal(resolveOllamaUrl({ IP: ' ::1 ' }), 'http://[::1]:11434');
  assert.equal(resolveOllamaUrl({ IP: '192.168.1.9', OLLAMA_URL: 'http://192.168.1.10:11500/' }), 'http://192.168.1.10:11500');
  assert.equal(resolveOllamaUrl({ IP: '192.168.1.9', NODE_ENV: 'production' }), 'http://127.0.0.1:11434');
  assert.equal(resolveOllamaUrl({}), 'http://127.0.0.1:11434');
  assert.throws(() => resolveOllamaUrl({ IP: 'http://192.168.1.9' }), /IP must be/);
});

test('anonymous account authenticates with its credential; forged user IDs do not grant access', async () => {
  const f = fixture(), a = await f.account();
  assert.equal((await f.request('GET', '/api/pet')).statusCode, 401);
  const response = await f.request('GET', '/api/pet?userId=someone-else', undefined, a.token);
  assert.equal(response.json().pet.name, 'Mochi');
  assert.equal((await f.request('GET', '/api/pet', undefined, 'forged')).statusCode, 401);
});

test('onboarding requires complete answers and creates a server-matched companion with a private profile', async () => {
  const f = fixture();
  const { token } = (await f.request('POST', '/api/account', {})).json();
  const profile = { nickname: 'Rae', pace: 'starting', interest: 'plants', tone: 'gentle' };
  assert.equal((await f.request('POST', '/api/onboarding', { profile, name: 'Fern' })).statusCode, 401);
  assert.equal((await f.request('POST', '/api/onboarding', { profile: { nickname: 'Rae' }, name: 'Fern' }, token)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/onboarding', { profile: { ...profile, tone: 'made-up' }, name: 'Fern' }, token)).statusCode, 400);
  assert.equal(f.store.rows('pets').length, 0);
  assert.equal((await f.request('GET', '/api/me', undefined, token)).json().profile, null);
  const result = await f.request('POST', '/api/onboarding', { profile, name: ' Fern ', species: 'fox', xp: 9000 }, token);
  assert.equal(result.statusCode, 201);
  assert.equal(result.json().pet.species, 'moss');
  assert.equal(result.json().pet.name, 'Fern');
  assert.equal(result.json().pet.xp, 0);
  assert.deepEqual((await f.request('GET', '/api/me', undefined, token)).json().profile, profile);
  assert.equal(result.json().pet.companion.nickname, undefined);
  const context = (await f.request('POST', '/api/context', { text: 'Say hello' }, token)).json();
  assert.match(context.messages[0].content, /calm, reassuring/);
  assert.match(context.messages[0].content, /short, easy outings/);
  assert.match(context.messages[0].content, /leaves & little flowers/);
});

test('legacy pet matching preserves earned progress and saved discoveries; completed setup is repeatable', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Buddy');
  const profile = { nickname: 'Ash', pace: 'often', interest: 'water', tone: 'bold' };
  await f.store.update('pets', { _id: a.pet._id }, { $set: { xp: 400, traits: ['flower fan'] } });
  await f.request('POST', '/api/memory', { text: 'A real old discovery', category: 'flower' }, a.token);
  const start = (await f.request('POST', '/api/walk/start', {}, a.token)).json().walk;
  assert.equal((await f.request('POST', '/api/onboarding', { profile, name: 'Mochi' }, a.token)).statusCode, 409);
  await f.request('POST', '/api/walk/end', { walkId: start._id, distanceM: 0, geoCells: [] }, a.token);
  const matched = await f.request('POST', '/api/onboarding', { profile, name: 'Mochi' }, a.token);
  assert.equal(matched.statusCode, 200);
  assert.equal(matched.json().pet._id, a.pet._id);
  assert.equal(matched.json().pet.species, 'drift');
  assert.equal(matched.json().pet.xp, 400);
  assert.equal(matched.json().pet.level, 3);
  assert.deepEqual(matched.json().pet.traits, ['flower fan']);
  assert.ok((await f.request('GET', '/api/memory', undefined, a.token)).json().memories.some((memory: any) => memory.text === 'A real old discovery'));
  const repeated = await f.request('POST', '/api/onboarding', { profile: { ...profile, interest: 'plants' }, name: 'Oops' }, a.token);
  assert.equal(repeated.json().pet.name, 'Mochi');
  assert.equal(repeated.json().pet.species, 'drift');
  const updated = await f.request('PUT', '/api/onboarding', { profile: { ...profile, interest: 'plants', tone: 'playful' }, name: 'Mochi' }, a.token);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().pet.species, 'pip');
  assert.equal(updated.json().pet.xp, 400);
  assert.equal(updated.json().pet.companion.tone, 'playful');
  await f.request('POST', '/api/friends', { code: a.friendCode }, b.token);
  const publicPet = (await f.request('GET', '/api/friends', undefined, b.token)).json().friends[0];
  assert.deepEqual(Object.keys(publicPet).sort(), ['equippedItems', 'id', 'level', 'name', 'species', 'traits']);
  assert.equal((await f.request('GET', '/api/me', undefined, b.token)).json().profile, null);
});

test('wildlife preference produces a playful briar mouse and the same personality context in both inference paths', async () => {
  const f = fixture();
  const { token } = (await f.request('POST', '/api/account', {})).json();
  const profile = { nickname: 'Kai', pace: 'sometimes', interest: 'wildlife', tone: 'playful' };
  const result = await f.request('POST', '/api/onboarding', { profile, name: 'Pip' }, token);
  assert.equal(result.json().pet.species, 'bramble');
  const messages: unknown[] = [];
  const app = createApp(f.store, { completion: async input => { messages.push(input); return 'Hello!'; } });
  for (const url of ['/api/context', '/api/local/chat']) {
    const reply = await inject(app as any, { method: 'POST', url, payload: { text: 'Hello' }, headers: { authorization: 'Bearer ' + token } });
    assert.equal(reply.statusCode, 200);
    if (url === '/api/context') messages.push(reply.json().messages);
  }
  assert.deepEqual(messages[0], messages[1]);
  assert.match(JSON.stringify(messages[0]), /goofy, playful/);
  assert.match(JSON.stringify(messages[0]), /regular walking habit/);
});

test('walk completion feeds the pet once, including concurrent end requests', async () => {
  const f = fixture(), a = await f.account();
  const start = await f.request('POST', '/api/walk/start', {}, a.token); const walkId = start.json().walk._id;
  f.advance(300_000);
  const payload = { walkId, distanceM: 1000, geoCells: ['12.3456,77.1234'], rawTrack: [{ lat: 12.345678, lon: 77.123456 }] };
  const results = await Promise.all([f.request('POST', '/api/walk/end', payload, a.token), f.request('POST', '/api/walk/end', payload, a.token)]);
  results.forEach(response => assert.equal(response.statusCode, 200));
  const pet = (await f.request('GET', '/api/pet', undefined, a.token)).json().pet;
  assert.equal(pet.xp, 100); assert.ok(pet.hunger > a.pet.hunger);
  const row = f.store.rows('walks')[0]; assert.equal(row.geoCells[0], geoCell(12.3456, 77.1234)); assert.equal(row.rawTrack, undefined);
  assert.equal(f.store.rows('memories').length, 1);
  assert.equal(f.store.rows('usageCounters').find(row => row._id === 'memory:' + a.pet._id)?.count, 1);
});

test('walk ownership is enforced and implausible distance is bounded by elapsed time', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  const walkId = (await f.request('POST', '/api/walk/start', {}, a.token)).json().walk._id;
  assert.equal((await f.request('POST', '/api/walk/end', { walkId, distanceM: 1000, geoCells: [] }, b.token)).statusCode, 404);
  f.advance(10_000);
  const result = await f.request('POST', '/api/walk/end', { walkId, distanceM: 1000, geoCells: [] }, a.token);
  assert.equal(result.json().walk.distanceM, 40);
});

test('Geoapify is preferred, keeps its credential server-side and normalizes nearby public places', async () => {
  let calls = 0;
  const feature = (id: string, categories: string[], extra = {}) => ({ type: 'Feature', properties: { place_id: id, categories, ...extra }, geometry: { type: 'Point', coordinates: [77.124, 12.345] } });
  const f = fixture(undefined, async (input, init) => {
    calls++;
    assert.equal(String(input), geoapifyUrl);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'test-geoapify-key');
    const body = JSON.parse(String(init?.body));
    const [lat, lon] = geoCell(12.3456, 77.1234).split(',').map(Number);
    assert.deepEqual(body.filter, { type: 'circle', lat, lon, radius: 2200 });
    assert.deepEqual(body.bias, { type: 'proximity', lat, lon });
    assert.equal(body.limit, 20);
    assert.deepEqual(body.categories, ['leisure.park', 'natural.water', 'highway.path']);
    return Response.json({ type: 'FeatureCollection', features: [
      feature('garden', ['leisure.park', 'leisure.park.garden'], { name: 'Real Garden' }),
      feature('garden', ['leisure.park.garden'], { name: 'Real Garden' }),
      feature('pond', ['natural.water.pond']),
      feature('trail', ['highway.path']),
      feature('invalid', ['leisure.park'], { lat: 999 }),
      feature('far', ['leisure.park'], { lat: 12.4, lon: 77.124 }),
      feature('private', ['leisure.park'], { datasource: { raw: { access: 'private' } } }),
    ] });
  }, 'test-geoapify-key');
  const a = await f.account(), url = '/api/places?lat=12.3456&lon=77.1234';
  const result = await f.request('GET', url, undefined, a.token);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().provider, 'geoapify');
  assert.equal(result.json().availability, 'ready');
  assert.deepEqual(result.json().places.map((p: any) => p.category).sort(), ['flower', 'tree', 'water']);
  assert.equal(result.json().places.find((p: any) => p.category === 'water').name, 'A nearby waterside');
  assert.ok(!result.body.includes('test-geoapify-key'));
  assert.ok(!JSON.stringify(f.store.rows('placesCache')).includes('test-geoapify-key'));
  const cached = await f.request('GET', url, undefined, a.token);
  assert.equal(cached.json().cacheHit, true);
  assert.equal(cached.json().provider, 'geoapify');
  assert.equal(calls, 1);
});

test('Geoapify authentication errors and malformed responses fall back without forwarding the key', async () => {
  for (const failure of [() => new Response('Forbidden', { status: 403 }), () => Response.json({ error: 'Invalid response' })]) {
    const calls: string[] = [];
    const f = fixture(undefined, async (input, init) => {
      calls.push(String(input));
      if (String(input) === geoapifyUrl) return failure();
      assert.equal(new Headers(init?.headers).get('x-api-key'), null);
      return Response.json({ elements: [{ type: 'node', id: 1, lat: 12.345, lon: 77.124, tags: { leisure: 'park', name: 'Fallback Park' } }] });
    }, 'test-geoapify-key');
    const a = await f.account();
    const result = await f.request('GET', '/api/places?lat=12.345&lon=77.124', undefined, a.token);
    assert.deepEqual(calls, [geoapifyUrl, placeProviders[0]]);
    assert.equal(result.json().provider, 'overpass');
    assert.equal(result.json().suggestion.name, 'Fallback Park');
    assert.ok(!result.body.includes('test-geoapify-key'));
  }
});

test('valid empty Geoapify results do not trigger unnecessary fallback requests', async () => {
  let calls = 0;
  const f = fixture(undefined, async input => {
    calls++; assert.equal(String(input), geoapifyUrl);
    return Response.json({ type: 'FeatureCollection', features: [] });
  }, 'test-geoapify-key');
  const a = await f.account();
  const result = await f.request('GET', '/api/places?lat=12.345&lon=77.124', undefined, a.token);
  assert.equal(result.json().availability, 'empty');
  assert.equal(result.json().provider, 'geoapify');
  assert.equal(result.json().suggestion, null);
  assert.equal(calls, 1);
});

test('Geoapify refreshes legacy caches on setup and retains attribution on saved spots during outages', async () => {
  const store = new DevelopmentStore(), cell = geoCell(12.345, 77.124);
  let time = Date.UTC(2026, 9, 10, 12), available = true, calls = 0;
  await store.insert('placesCache', { _id: cell, places: [], freshUntil: new Date(time + 86_400_000), expiresAt: new Date(time + 30 * 86_400_000), retryAfter: new Date(time + 60_000) });
  const nearby = createPlaceLookup(store, { geoapifyKey: 'test-geoapify-key', now: () => time, fetch: async input => {
    calls++;
    if (!available) throw new Error('Offline');
    assert.equal(String(input), geoapifyUrl);
    return Response.json({ type: 'FeatureCollection', features: [{ properties: { place_id: 'park', name: 'Saved Park', lat: 12.345, lon: 77.124, categories: ['leisure.park'] } }] });
  } });
  assert.equal((await nearby(12.345, 77.124)).provider, 'geoapify');
  assert.equal(calls, 1);
  time += 86_400_001; available = false;
  const saved = await nearby(12.345, 77.124);
  assert.equal(saved.stale, true);
  assert.equal(saved.provider, 'geoapify');
  assert.equal(saved.places[0].name, 'Saved Park');
  await nearby(12.345, 77.124);
  assert.equal(calls, 4);
  time += 60_001; available = true;
  assert.equal((await nearby(12.345, 77.124)).stale, false);
  assert.equal(calls, 5);
});

test('shop starts with no invented points and supports free outfits, removal and persistence', async () => {
  const f = fixture(), a = await f.account();
  const initial = await f.request('GET', '/api/shop', undefined, a.token);
  assert.equal(initial.json().points, 0);
  assert.equal(initial.json().catalog.length, 5);
  assert.deepEqual(initial.json().ownedItems, []);
  const gift = await f.request('POST', '/api/shop/purchase', { itemId: 'trail-bandana' }, a.token);
  assert.equal(gift.statusCode, 200);
  assert.equal(gift.json().points, 0);
  assert.equal(gift.json().equippedItems.neck, 'trail-bandana');
  assert.deepEqual((await f.request('GET', '/api/pet', undefined, a.token)).json().pet.ownedItems, ['trail-bandana']);
  assert.equal((await f.request('POST', '/api/shop/equip', { slot: 'neck', itemId: null }, a.token)).statusCode, 200);
  const saved = (await f.request('GET', '/api/shop', undefined, a.token)).json();
  assert.deepEqual(saved.equippedItems, {});
  assert.deepEqual(saved.ownedItems, ['trail-bandana']);
  assert.equal((await f.request('POST', '/api/shop/equip', { slot: 'neck', itemId: 'trail-bandana' }, a.token)).json().equippedItems.neck, 'trail-bandana');
});

test('shop enforces ownership, real prices and authentication without accepting client balances', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  assert.equal((await f.request('GET', '/api/shop')).statusCode, 401);
  assert.equal((await f.request('POST', '/api/shop/purchase', { itemId: 'mushroom-cap' }, a.token)).statusCode, 422);
  assert.equal((await f.request('POST', '/api/shop/purchase', { itemId: 'mushroom-cap', price: 0, points: 999 }, a.token)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/shop/purchase', { itemId: 'invented-item' }, a.token)).statusCode, 404);
  assert.equal((await f.request('POST', '/api/shop/equip', { slot: 'head', itemId: 'mushroom-cap' }, a.token)).statusCode, 403);
  assert.equal((await f.request('POST', '/api/shop/equip', { slot: 'face', itemId: 'mushroom-cap' }, a.token)).statusCode, 400);
  await f.request('POST', '/api/shop/purchase', { itemId: 'daisy-pin' }, a.token);
  assert.equal((await f.request('POST', '/api/shop/equip', { slot: 'badge', itemId: 'daisy-pin' }, b.token)).statusCode, 403);
  assert.deepEqual((await f.request('GET', '/api/shop', undefined, b.token)).json().ownedItems, []);
});

test('simultaneous repeated purchases charge once and never spend lifetime XP', async () => {
  const f = fixture(), a = await f.account();
  await f.store.update('pets', { _id: a.pet._id }, { $set: { points: 300, xp: 500 } });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.request('POST', '/api/shop/purchase', { itemId: 'mushroom-cap' }, a.token)));
  assert.ok(results.every(result => result.statusCode === 200));
  const saved = (await f.request('GET', '/api/shop', undefined, a.token)).json();
  assert.equal(saved.points, 180);
  assert.deepEqual(saved.ownedItems, ['mushroom-cap']);
  assert.equal(saved.pet.xp, 500);
  assert.equal(saved.pet.level, levelFor(500));
  assert.equal(saved.equippedItems.head, 'mushroom-cap');
});

test('simultaneous different purchases cannot overspend the wallet or overwrite other outfit slots', async () => {
  const f = fixture(), a = await f.account();
  await f.store.update('pets', { _id: a.pet._id }, { $set: { points: 180 } });
  const results = await Promise.all(['mushroom-cap', 'moon-scarf'].map(itemId => f.request('POST', '/api/shop/purchase', { itemId }, a.token)));
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 422]);
  let saved = (await f.request('GET', '/api/shop', undefined, a.token)).json();
  assert.equal(saved.ownedItems.length, 1);
  const cost = saved.catalog.find((item: any) => item.id === saved.ownedItems[0]).price;
  assert.equal(saved.points, 180 - cost);
  await Promise.all(['trail-bandana', 'daisy-pin'].map(itemId => f.request('POST', '/api/shop/purchase', { itemId }, a.token)));
  saved = (await f.request('GET', '/api/shop', undefined, a.token)).json();
  assert.equal(saved.equippedItems.neck, 'trail-bandana');
  assert.equal(saved.equippedItems.badge, 'daisy-pin');
  if (saved.ownedItems.includes('mushroom-cap')) assert.equal(saved.equippedItems.head, 'mushroom-cap');
  assert.equal(saved.ownedItems.length, 3);
});

test('legacy pets can get starter items and rematching preserves owned clothes and wallet', async () => {
  const f = fixture(), a = await f.account();
  const old = f.store.rows('pets').find(pet => pet._id === a.pet._id)!;
  for (const field of ['points', 'ownedItems', 'equippedItems', 'wardrobeVersion']) delete old[field];
  const gift = await f.request('POST', '/api/shop/purchase', { itemId: 'daisy-pin' }, a.token);
  assert.equal(gift.statusCode, 200);
  assert.equal(gift.json().points, 0);
  await f.store.update('pets', { _id: a.pet._id }, { $set: { points: 200 } });
  await f.request('POST', '/api/shop/purchase', { itemId: 'mushroom-cap' }, a.token);
  const rematched = await f.request('PUT', '/api/onboarding', { profile: { nickname: 'Rae', pace: 'sometimes', interest: 'water', tone: 'playful' }, name: 'Fern' }, a.token);
  assert.equal(rematched.json().pet.species, 'dew');
  const saved = (await f.request('GET', '/api/shop', undefined, a.token)).json();
  assert.equal(saved.points, 80);
  assert.deepEqual(saved.ownedItems.sort(), ['daisy-pin', 'mushroom-cap']);
  assert.equal(saved.equippedItems.head, 'mushroom-cap');
  assert.equal(saved.equippedItems.badge, 'daisy-pin');
});

test('walk rewards keep shop points unchanged until event rewards are defined', async () => {
  const f = fixture(), a = await f.account();
  const walk = (await f.request('POST', '/api/walk/start', {}, a.token)).json().walk;
  f.advance(600_000);
  const ended = await f.request('POST', '/api/walk/end', { walkId: walk._id, distanceM: 1000, geoCells: [] }, a.token);
  assert.equal(ended.json().pet.xp, 100);
  assert.equal(ended.json().pet.points, 0);
});

test('nearby places fail over, validate spots and reuse cached results without spending more quota', async () => {
  const calls: string[] = [], queries: string[] = [];
  const f = fixture(undefined, async (input, init) => {
    calls.push(String(input)); queries.push(String(init?.body));
    if (calls.length === 1) return new Response('Busy', { status: 429 });
    return Response.json({ elements: [
      { type: 'way', id: 1, center: { lat: 12.345, lon: 77.124 }, tags: { leisure: 'park', name: 'Real Park' } },
      { type: 'node', id: 2, lat: 12.345, lon: 77.124, tags: { leisure: 'garden', name: 'Real Garden' } },
      { type: 'node', id: 3, lat: 999, lon: 77.124, tags: { leisure: 'park' } },
      { type: 'node', id: 4, lat: 12.4, lon: 77.124, tags: { leisure: 'park', name: 'Too far' } },
      { type: 'node', id: 5, lat: 12.345, lon: 77.124, tags: { leisure: 'park', access: 'private' } },
    ] });
  });
  const a = await f.account(), url = '/api/places?lat=12.3456&lon=77.1234';
  await f.request('POST', '/api/memory', { text: 'An old tree', category: 'tree' }, a.token);
  const response = await f.request('GET', url, undefined, a.token);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, placeProviders);
  assert.ok(!queries[0].includes('12.3456'));
  assert.equal(response.json().availability, 'ready');
  assert.equal(response.json().stale, false);
  assert.equal(response.json().suggestion.name, 'Real Garden');
  assert.deepEqual(response.json().places.map((p: any) => p.name).sort(), ['Real Garden', 'Real Park']);
  for (let i = 0; i < 35; i++) {
    const cached = await f.request('GET', url, undefined, a.token);
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.json().cacheHit, true);
  }
  assert.equal(calls.length, 2);
  assert.equal((await f.request('GET', '/api/usage', undefined, a.token)).json().places, 1);
});

test('nearby places keep saved spots during outages and refresh them when a provider recovers', async () => {
  let available = true, calls = 0;
  const f = fixture(undefined, async () => {
    calls++;
    if (!available) throw new Error('Offline');
    return Response.json({ elements: [{ type: 'node', id: 1, lat: 12.345, lon: 77.124, tags: { leisure: 'park', name: 'Saved Park' } }] });
  });
  const a = await f.account(), url = '/api/places?lat=12.345&lon=77.124';
  await f.request('GET', url, undefined, a.token);
  f.advance(86_400_001); available = false;
  const stale = await f.request('GET', url, undefined, a.token);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().availability, 'ready');
  assert.equal(stale.json().stale, true);
  assert.equal(stale.json().suggestion.name, 'Saved Park');
  await f.request('GET', url, undefined, a.token);
  assert.equal(calls, 3);
  f.advance(60_001); available = true;
  const recovered = await f.request('GET', url, undefined, a.token);
  assert.equal(recovered.json().stale, false);
  assert.equal(recovered.json().suggestion.name, 'Saved Park');
  assert.equal(calls, 4);
});

test('nearby lookup distinguishes outages from empty results and does not repeatedly call failed providers', async () => {
  let available = false, calls = 0;
  const f = fixture(undefined, async () => {
    calls++;
    return available ? Response.json({ elements: [] }) : Response.json({ elements: [], remark: 'runtime error: timeout' });
  });
  const a = await f.account(), url = '/api/places?lat=12.345&lon=77.124';
  const results = await Promise.all([f.request('GET', url, undefined, a.token), f.request('GET', url, undefined, a.token)]);
  for (const response of results) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().availability, 'unavailable');
    assert.equal(response.json().suggestion, null);
    assert.deepEqual(response.json().places, []);
  }
  assert.equal(calls, 2);
  const retry = await f.request('GET', url, undefined, a.token);
  assert.equal(retry.json().availability, 'unavailable');
  assert.equal(calls, 2);
  f.advance(60_001); available = true;
  const empty = await f.request('GET', url, undefined, a.token);
  assert.equal(empty.json().availability, 'empty');
  assert.equal(calls, 3);
});

test('nearby lookup falls back on malformed responses and shares refreshes without sharing private preferences', async () => {
  let calls = 0;
  const f = fixture(undefined, async () => {
    calls++;
    if (calls === 1) return new Response('<html>Busy</html>');
    return Response.json({ elements: [
      { type: 'node', id: 1, lat: 12.345, lon: 77.124, tags: { leisure: 'park', name: 'Park' } },
      { type: 'node', id: 2, lat: 12.345, lon: 77.124, tags: { natural: 'water', name: 'Pond' } },
    ] });
  });
  const a = await f.account(), b = await f.account('Fern');
  await f.request('POST', '/api/memory', { text: 'Private tree memory', category: 'tree' }, a.token);
  await f.request('POST', '/api/memory', { text: 'Private water memory', category: 'water' }, b.token);
  const responses = await Promise.all([a, b].map(account => f.request('GET', '/api/places?lat=12.345&lon=77.124', undefined, account.token)));
  assert.equal(calls, 2);
  assert.equal(responses[0].json().suggestion.name, 'Pond');
  assert.equal(responses[1].json().suggestion.name, 'Park');
  assert.ok(responses.every(response => !response.body.includes('Private')));
  assert.equal((await f.request('GET', '/api/places?lat=999&lon=77.124', undefined, a.token)).statusCode, 400);
});

test('nearby cache remains usable at the live lookup limit and expired saved data is not suggested', async () => {
  let calls = 0;
  const f = fixture(undefined, async () => {
    calls++;
    return Response.json({ elements: [{ type: 'node', id: 1, lat: 12.345, lon: 77.124, tags: { leisure: 'park', name: 'Park' } }] });
  });
  const a = await f.account(), url = '/api/places?lat=12.345&lon=77.124';
  await f.request('GET', url, undefined, a.token);
  const counter = f.store.rows('usageCounters').find(row => row._id.includes(':places:'))!;
  await f.store.update('usageCounters', { _id: counter._id }, { $set: { count: 30 } });
  const cached = await f.request('GET', url, undefined, a.token);
  assert.equal(cached.json().suggestion.name, 'Park');
  const limited = await f.request('GET', '/api/places?lat=13&lon=77', undefined, a.token);
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.json().availability, 'unavailable');
  assert.equal(calls, 1);
  f.advance(31 * 86_400_000);
  await f.store.update('usageCounters', { _id: a.pet.userId + ':places:' + new Date(a.pet.updatedAt + 31 * 86_400_000).toISOString().slice(0, 10) }, { $set: { count: 30 } }, true);
  const expired = await f.request('GET', url, undefined, a.token);
  assert.equal(expired.json().suggestion, null);
  assert.equal(expired.json().availability, 'unavailable');
});

test('unrecorded walks disappoint without rewards or memories, and a short walk restores mood', async () => {
  const f = fixture(), a = await f.account();
  const previousWalkAt = a.pet.updatedAt - 3_600_000;
  await f.store.update('pets', { _id: a.pet._id }, { $set: { lastWalkAt: previousWalkAt } });
  for (const distanceM of [0, 9]) {
    const walkId = (await f.request('POST', '/api/walk/start', {}, a.token)).json().walk._id;
    f.advance(10_000);
    const before = (await f.request('GET', '/api/pet', undefined, a.token)).json().pet;
    const payload = { walkId, distanceM, geoCells: [] };
    const ended = await f.request('POST', '/api/walk/end', payload, a.token);
    assert.equal(ended.statusCode, 200);
    assert.deepEqual(ended.json().reward, { xp: 0, food: 0 });
    assert.equal(ended.json().pet.mood, 35);
    assert.equal(ended.json().pet.hunger, before.hunger);
    assert.equal(ended.json().pet.lastWalkAt, previousWalkAt);
    assert.equal(ended.json().pet.xp, 0);
    assert.equal(f.store.rows('memories').length, 0);
    const retried = await f.request('POST', '/api/walk/end', { ...payload, distanceM: 1000 }, a.token);
    assert.equal(retried.json().pet.mood, 35);
    assert.equal(retried.json().pet.xp, 0);
    assert.equal(retried.json().walk.distanceM, distanceM);
  }
  const context = await f.request('POST', '/api/context', { text: 'How are you feeling?' }, a.token);
  assert.match(context.json().messages[0].content, /feel a little disappointed/);
  const walkId = (await f.request('POST', '/api/walk/start', {}, a.token)).json().walk._id;
  f.advance(10_000);
  const before = (await f.request('GET', '/api/pet', undefined, a.token)).json().pet;
  const payload = { walkId, distanceM: 10, geoCells: [] };
  const ended = await f.request('POST', '/api/walk/end', payload, a.token);
  assert.equal(ended.statusCode, 200);
  assert.deepEqual(ended.json().reward, { xp: 1, food: .4 });
  assert.equal(ended.json().pet.mood, 50);
  assert.ok(ended.json().pet.hunger > before.hunger);
  assert.equal(ended.json().pet.lastWalkAt, ended.json().walk.endedAt);
  assert.equal(f.store.rows('memories').length, 1);
  const retried = await f.request('POST', '/api/walk/end', payload, a.token);
  assert.equal(retried.json().pet.mood, 50);
  assert.equal(retried.json().pet.xp, 1);
  assert.equal(f.store.rows('memories').length, 1);
});

test('photo check persists label and embedding array without image bytes or precise coordinates', async () => {
  const f = fixture(), a = await f.account();
  const image = 'data:image/jpeg;base64,AAAA';
  const result = await f.request('POST', '/api/local/vision', { image, lat: 12.345678 }, a.token);
  assert.equal(result.statusCode, 200);
  await new Promise(resolve => setImmediate(resolve));
  const memory = f.store.rows('memories')[0]; assert.equal(memory.embedding.length, 384); assert.equal(memory.embeddingStatus, 'ready');
  assert.equal(memory.image, undefined); assert.equal(memory.lat, undefined); assert.ok(!JSON.stringify(memory).includes(image));
  const list = (await f.request('GET', '/api/memory', undefined, a.token)).json().memories; assert.equal(list[0].embedding, undefined);
});

test('opt-in discovery photos stay private, outside prompts and sync payloads, and continue across QR sessions', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  const image = 'data:image/jpeg;base64,' + bytes.toString('base64');
  const created = await f.request('POST', '/api/memory', { text: 'A little yellow flower', category: 'flower', image }, a.token);
  assert.equal(created.statusCode, 201);
  const id = created.json().memory._id;
  assert.equal(created.json().memory.hasPhoto, true);
  assert.equal(created.body.includes(image), false);
  assert.equal(f.store.rows('memories')[0].image, undefined);
  assert.equal(f.store.rows('memories')[0].bytes, undefined);
  await new Promise(resolve => setImmediate(resolve));
  for (const path of ['/api/memory', '/api/sync']) assert.equal((await f.request('GET', path, undefined, a.token)).body.includes(image), false);
  assert.equal((await f.request('POST', '/api/context', { text: 'Remember the flower?' }, a.token)).body.includes(image), false);
  const path = '/api/memory/' + id + '/photo';
  assert.equal((await f.request('GET', path)).statusCode, 401);
  assert.equal((await f.request('GET', path, undefined, b.token)).statusCode, 404);
  const photo = await f.request('GET', path, undefined, a.token);
  assert.equal(photo.headers['content-type'], 'image/jpeg');
  assert.equal(photo.headers['cache-control'], 'no-store');
  assert.deepEqual(photo.rawPayload, bytes);
  f.store.rows('memoryPhotos')[0].bytes = new Binary(bytes);
  assert.deepEqual((await f.request('GET', path, undefined, a.token)).rawPayload, bytes);
  const handoff = await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: { mode: 'host', muted: true, keepPhotos: true, tab: 'journal', line: '', welcome: false, editing: false } }, a.token);
  const code = new URLSearchParams(new URL(handoff.json().url).hash.slice(1)).get('continue');
  const phone = (await f.request('POST', '/api/handoff/claim', { code })).json();
  assert.equal(phone.preferences.keepPhotos, true);
  assert.deepEqual((await f.request('GET', path, undefined, phone.token)).rawPayload, bytes);
  await f.request('DELETE', '/api/account', undefined, a.token);
  assert.equal(f.store.rows('memoryPhotos').length, 0);
  assert.equal(await f.store.findOne('usageCounters', { _id: 'photo:' + a.pet._id }), null);
});

test('photo slots are bounded under concurrent saves, notes still work, and clearing memories releases storage', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  const image = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  await f.request('POST', '/api/memory', { text: 'Fern’s private photo', category: 'tree', image }, b.token);
  await f.store.reserve('photo:' + a.pet._id, 50, 'photos', new Date('2100-01-01'));
  await f.store.update('usageCounters', { _id: 'photo:' + a.pet._id }, { $set: { count: 49 } });
  const attempts = await Promise.all([1, 2, 3].map(i => f.request('POST', '/api/memory', { text: 'Flower ' + i, category: 'flower', image }, a.token)));
  assert.deepEqual(attempts.map(reply => reply.statusCode).sort(), [201, 429, 429]);
  assert.ok(attempts.filter(reply => reply.statusCode === 429).every(reply => reply.json().reason === 'photo_limit'));
  assert.equal((await f.store.findOne('usageCounters', { _id: 'photo:' + a.pet._id }))!.count, 50);
  assert.equal((await f.store.findOne('usageCounters', { _id: 'memory:' + a.pet._id }))!.count, 1);
  assert.equal((await f.request('POST', '/api/memory', { text: 'A note without a photo', category: 'sky' }, a.token)).statusCode, 201);
  const savedId = f.store.rows('memoryPhotos').find(row => row.petId === a.pet._id)!._id;
  await f.request('DELETE', '/api/memory', undefined, a.token);
  assert.equal((await f.request('GET', '/api/memory/' + savedId + '/photo', undefined, a.token)).statusCode, 404);
  assert.equal(f.store.rows('memoryPhotos').length, 1);
  assert.equal(f.store.rows('memoryPhotos')[0].petId, b.pet._id);
  assert.equal(await f.store.findOne('usageCounters', { _id: 'photo:' + a.pet._id }), null);
  assert.equal((await f.request('POST', '/api/memory', { text: 'A new photo', category: 'flower', image }, a.token)).statusCode, 201);
});

test('saved photos reject remote, oversized, and non-JPEG input and roll back failed memory writes', async t => {
  const f = fixture(), a = await f.account();
  for (const image of ['https://private.example/photo.jpg', 'data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,' + Buffer.alloc(150_001).toString('base64')]) {
    assert.equal((await f.request('POST', '/api/memory', { text: 'A photo', category: 'flower', image }, a.token)).statusCode, 400);
  }
  assert.equal(f.store.rows('memoryPhotos').length, 0);
  const image = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const insert = f.store.insert.bind(f.store);
  t.mock.method(f.store, 'insert', async (name: string, row: Row) => { if (name === 'memories') throw new Error('Database write failed'); return insert(name, row); });
  assert.equal((await f.request('POST', '/api/memory', { text: 'A photo', category: 'flower', image }, a.token)).statusCode, 500);
  assert.equal(f.store.rows('memoryPhotos').length, 0);
  assert.equal((await f.store.findOne('usageCounters', { _id: 'memory:' + a.pet._id }))!.count, 0);
  assert.equal((await f.store.findOne('usageCounters', { _id: 'photo:' + a.pet._id }))!.count, 0);
});

test('developer photo inference retains its image only with explicit photo saving', async () => {
  const f = fixture(), a = await f.account();
  const image = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  assert.equal((await f.request('POST', '/api/local/vision', { image, keepPhoto: true }, a.token)).statusCode, 200);
  assert.equal(f.store.rows('memoryPhotos').length, 1);
  assert.equal(f.store.rows('memories')[0].hasPhoto, true);
  assert.equal((await f.request('POST', '/api/local/vision', { image }, a.token)).statusCode, 200);
  assert.equal(f.store.rows('memoryPhotos').length, 1);
  assert.equal(f.store.rows('memories')[1].hasPhoto, undefined);
});

test('memory retrieval scopes to the authenticated pet and delete clears its storage quota', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  await f.request('POST', '/api/memory', { text: 'A yellow flower', category: 'flower', petId: b.pet._id, geoCell: '12.3456,77.1234' }, a.token);
  await f.request('POST', '/api/memory', { text: 'A private memory of Fern', category: 'tree' }, b.token);
  await new Promise(resolve => setImmediate(resolve));
  const context = (await f.request('POST', '/api/context', { text: 'Remember the flower?' }, a.token)).json();
  assert.equal(context.memories.length, 1); assert.equal(context.memories[0].text, 'A yellow flower');
  assert.ok(!JSON.stringify(context).includes('A private memory of Fern'));
  await f.request('DELETE', '/api/memory', undefined, a.token);
  assert.equal((await f.request('GET', '/api/memory', undefined, a.token)).json().memories.length, 0);
  assert.equal((await f.request('GET', '/api/memory', undefined, b.token)).json().memories.length, 1);
  assert.equal(await f.store.findOne('usageCounters', { _id: 'memory:' + a.pet._id }), null);
});

test('friend link is reciprocal and idempotent; pet cards exclude private data', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  await f.request('POST', '/api/friends', { code: b.friendCode }, a.token);
  await f.request('POST', '/api/friends', { code: b.friendCode }, a.token);
  assert.equal(f.store.rows('friendships').length, 1);
  const left = (await f.request('GET', '/api/friends', undefined, a.token)).json().friends;
  const right = (await f.request('GET', '/api/friends', undefined, b.token)).json().friends;
  assert.equal(left[0].name, 'Fern'); assert.equal(right[0].name, 'Mochi');
  assert.deepEqual(Object.keys(left[0]).sort(), ['equippedItems', 'id', 'level', 'name', 'species', 'traits']);
  await f.store.update('pets', { _id: b.pet._id }, { $set: { points: 300 } });
  await f.request('POST', '/api/shop/purchase', { itemId: 'mushroom-cap' }, b.token);
  const dressedFriend = (await f.request('GET', '/api/friends', undefined, a.token)).json().friends[0];
  assert.equal(dressedFriend.equippedItems.head, 'mushroom-cap');
  assert.equal(dressedFriend.points, undefined);
  assert.equal(dressedFriend.ownedItems, undefined);
  assert.equal((await f.request('POST', '/api/friends', { code: a.friendCode }, a.token)).statusCode, 400);
});

test('failed memory preparation can recover without duplicating memories or crossing pets', async () => {
  let available = false;
  const f = fixture(async () => { if (!available) throw new Error('Offline'); return [1, ...Array(383).fill(0)]; });
  const a = await f.account(), b = await f.account('Fern');
  await f.request('POST', '/api/memory', { text: 'A flower for Mochi', category: 'flower' }, a.token);
  await f.request('POST', '/api/memory', { text: 'A tree for Fern', category: 'tree' }, b.token);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.store.rows('memories').every(row => row.embeddingStatus === 'unavailable'));
  available = true;
  assert.equal((await f.request('POST', '/api/memory/retry', { petId: a.pet._id }, b.token)).statusCode, 200);
  assert.equal(f.store.rows('memories').find(row => row.petId === a.pet._id)?.embeddingStatus, 'unavailable');
  assert.equal(f.store.rows('memories').find(row => row.petId === b.pet._id)?.embeddingStatus, 'ready');
  await f.request('POST', '/api/memory/retry', {}, a.token);
  assert.equal(f.store.rows('memories').length, 2);
  assert.equal(f.store.rows('usageCounters').find(row => row._id === 'memory:' + a.pet._id)?.count, 1);
});

test('storage cap, invalid coordinates and photos, and removed hosted routes are enforced', async () => {
  const f = fixture(), a = await f.account();
  assert.equal((await f.request('POST', '/api/memory', { text: 'A flower', category: 'flower', geoCell: '999.0000,77.0000' }, a.token)).statusCode, 400);
  assert.equal(await f.store.findOne('usageCounters', { _id: 'memory:' + a.pet._id }), null);
  await f.store.update('usageCounters', { _id: 'memory:' + a.pet._id }, { $set: { count: 500 } }, true);
  assert.equal((await f.request('POST', '/api/memory', { text: 'A flower', category: 'flower' }, a.token)).statusCode, 429);
  assert.equal(f.store.rows('memories').length, 0);
  assert.equal((await f.request('POST', '/api/local/vision', { image: 'https://private.example/image.jpg' }, a.token)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/local/vision', { image: 'data:image/jpeg;base64,' + Buffer.alloc(150_001).toString('base64') }, a.token)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/vision', { image: 'data:image/jpeg;base64,AAAA' }, a.token)).statusCode, 404);
});

test('anonymous signup is limited to five accounts per IP per hour', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) assert.equal((await f.request('POST', '/api/account', {})).statusCode, 201);
  assert.equal((await f.request('POST', '/api/account', {})).statusCode, 429);
  f.advance(3_600_000);
  assert.equal((await f.request('POST', '/api/account', {})).statusCode, 201);
});

test('local chat has a burst guard without a hosted model or daily allowance', async () => {
  const f = fixture(), a = await f.account();
  for (let i = 0; i < 30; i++) assert.equal((await f.request('POST', '/api/local/chat', { text: 'Hi' }, a.token)).statusCode, 200);
  assert.equal((await f.request('POST', '/api/local/chat', { text: 'Hi' }, a.token)).statusCode, 429);
  f.advance(60_000);
  assert.equal((await f.request('POST', '/api/local/chat', { text: 'Hi' }, a.token)).statusCode, 200);
  assert.equal((await f.request('POST', '/api/chat', { text: 'Hi' }, a.token)).statusCode, 404);
  const health = (await f.request('GET', '/api/health')).json();
  assert.equal('cloudBrain' in health, false);
  assert.equal('cloudVision' in health, false);
});

test('deleting an account removes pet, memories, walks and friendships and revokes its credential', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  await f.request('POST', '/api/friends', { code: b.friendCode }, a.token);
  await f.request('POST', '/api/memory', { text: 'A flower', category: 'flower' }, a.token);
  await f.request('POST', '/api/walk/start', {}, a.token);
  assert.equal((await f.request('DELETE', '/api/account', undefined, a.token)).statusCode, 200);
  assert.equal((await f.request('GET', '/api/pet', undefined, a.token)).statusCode, 401);
  assert.equal((await f.request('GET', '/api/friends', undefined, b.token)).json().friends.length, 0);
  assert.equal(f.store.rows('walks').length, 0); assert.equal(f.store.rows('memories').length, 0);
});

test('laptop bridge requires token, limits requests, restricts origins and rejects remote image URLs', async () => {
  const app = createBridge('a'.repeat(43), 'https://pawpath.example', async () => 'Hello, little wanderer.', async () => true);
  assert.equal((await inject(app as any, { method: 'GET', url: '/health' })).statusCode, 401);
  assert.equal((await inject(app as any, { method: 'GET', url: '/health', headers: { 'x-pairing-token': 'a'.repeat(43), origin: 'https://elsewhere.example' } })).statusCode, 403);
  const headers = { 'x-pairing-token': 'a'.repeat(43), origin: 'https://pawpath.example' };
  assert.equal((await inject(app as any, { method: 'GET', url: '/health', headers })).json().online, true);
  assert.equal((await inject(app as any, { method: 'OPTIONS', url: '/v1/chat/completions', headers: { origin: 'https://pawpath.example' } })).statusCode, 204);
  assert.equal((await inject(app as any, { method: 'POST', url: '/v1/chat/completions', headers, payload: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.example' } }] }] } })).statusCode, 400);
  for (let i = 0; i < 30; i++) assert.equal((await inject(app as any, { method: 'POST', url: '/v1/chat/completions', headers, payload: { messages: [{ role: 'user', content: 'Hello' }] } })).statusCode, 200);
  assert.equal((await inject(app as any, { method: 'POST', url: '/v1/chat/completions', headers, payload: { messages: [{ role: 'user', content: 'Hello' }] } })).statusCode, 429);
});

test('laptop status reports an unavailable Gemma model as offline', async () => {
  const app = createBridge('a'.repeat(43), 'https://pawpath.example', async () => 'Hello.', async () => false);
  const result = await inject(app as any, { method: 'GET', url: '/health', headers: { 'x-pairing-token': 'a'.repeat(43) } });
  assert.equal(result.statusCode, 503); assert.equal(result.json().online, false);
});

test('GPS rejects poor accuracy, impossible jumps, stationary noise and background gaps', () => {
  const previous = { lat: 12, lon: 77, accuracy: 5, timestamp: 1000 };
  assert.equal(acceptedStep(previous, { ...previous, accuracy: 100, timestamp: 11_000 }).meters, 0);
  assert.equal(acceptedStep(previous, { ...previous, lat: 13, timestamp: 11_000 }).meters, 0);
  assert.equal(acceptedStep(previous, { ...previous, lat: 12.00001, timestamp: 11_000 }).meters, 0);
  assert.equal(acceptedStep(previous, { ...previous, lat: 12.01, timestamp: 61_000 }).meters, 0);
  assert.ok(acceptedStep(previous, { ...previous, lat: 12.0001, timestamp: 11_000 }).meters > 10);
});

test('pet state decays without inference and vision rejects malformed or invalid JSON', () => {
  const pet = { _id: 'pet', userId: 'user', name: 'Mochi', species: 'fox' as const, hunger: 60, mood: 80, energy: 60, xp: 400, level: 1, traits: [], updatedAt: 0 };
  assert.equal(currentPet(pet, 3_600_000).hunger, 58); assert.equal(levelFor(400), 3); assert.equal(walkReward(1000).food, 40);
  assert.throws(() => parseVision('not JSON')); assert.throws(() => parseVision('{"is_outdoor":"yes"}'));
  assert.equal(parseVision('```json\n{"is_outdoor":true,"category":"tree","label":"A big oak"}\n```').category, 'tree');
});

test('outdoor discoveries accept unfamiliar model categories without exposing parser details', () => {
  for (const category of ['plant', 'insect', 'street', 'animal', 'trail']) {
    const result = readVision(JSON.stringify({ is_outdoor: true, category, label: 'A potted plant on a balcony', is_screen: false }));
    assert.equal(result.category, 'other');
    assert.equal(result.is_outdoor, true);
    assert.equal(result.label, 'A potted plant on a balcony');
  }
  assert.equal(readVision(JSON.stringify({ is_outdoor: true, category: ' TREE ', label: 'An oak' })).category, 'tree');
  assert.equal(readVision(JSON.stringify({ is_outdoor: false, category: 'plant', label: 'An indoor plant' })).is_outdoor, false);
  assert.equal(readVision(JSON.stringify({ is_outdoor: true, category: 'plant', label: 'A photo on a screen', is_screen: true })).is_screen, true);
  for (const reply of ['not JSON', '{"is_outdoor":"yes","category":"plant","label":"A plant"}', '{"is_outdoor":true,"category":"plant","label":" "}']) {
    assert.throws(() => readVision(reply), { name: 'Error', message: 'Gemma could not read that discovery. Try a clearer outdoor photo.' });
  }
});

test('potted plant discoveries save as other and invalid requests return plain-language errors', async () => {
  const f = fixture(), a = await f.account();
  const app = createApp(f.store, { embed: async () => [1, ...Array(383).fill(0)], completion: async () => JSON.stringify({ is_outdoor: true, category: 'plant', label: 'A leafy potted plant outside', is_screen: false }) });
  const response = await inject(app as any, { method: 'POST', url: '/api/local/vision', headers: { authorization: 'Bearer ' + a.token }, payload: { image: 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff]).toString('base64') } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().result.category, 'other');
  assert.ok((await f.store.find('memories', { petId: a.pet._id })).some(memory => memory.text === 'A leafy potted plant outside' && memory.category === 'other'));
  const invalid = await f.request('POST', '/api/memory', { text: 'A plant', category: 'plant' }, a.token);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { reason: 'validation', message: 'Check the details and try again.' });
});

test('Gemma place choice resolves only to real candidates and keeps its prompt within chat bounds', () => {
  const places = [1, 2, 3].map(id => ({ id: 'node:' + id, name: 'Park '.repeat(50), category: 'tree' as const, lat: 12, lon: 77, distanceM: 100 * id }));
  assert.ok(placePrompt(places, []).length <= 500);
  assert.equal(readPlaceChoice('2|Those trees look like a lovely adventure.', places).place.id, 'node:2');
  assert.throws(() => readPlaceChoice('4|An invented destination.', places));
  assert.throws(() => readPlaceChoice('I know a completely different park.', places));
});


test('local Gemma returns a short answer without spending its reply budget on reasoning', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const message = request.reasoning_effort === 'none'
      ? { content: 'Ready! Let’s find something outside.' }
      : { content: '', reasoning: 'Reasoning exhausted the short reply budget.' };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 30 } }), { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(await completion([{ role: 'user', content: 'Ready for a walk?' }], 'local'), 'Ready! Let’s find something outside.');
});

test('all ten companions can be matched from complete answers, with server and preview sharing the result', async () => {
  const found = new Set<string>();
  for (const pace of paceOptions) for (const interest of interestOptions) for (const tone of toneOptions) {
    const f = fixture();
    const profile = { nickname: 'Walker', pace: pace.value, interest: interest.value, tone: tone.value };
    const { token } = (await f.request('POST', '/api/account', {})).json();
    const result = await f.request('POST', '/api/onboarding', { profile, name: 'Buddy' }, token);
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().pet.species, matchCompanion(profile).species);
    found.add(result.json().pet.species);
  }
  assert.deepEqual([...found].sort(), [...species].sort());
});

test('legacy appearances resolve to pixel companions without changing saved progress or outfits', () => {
  for (const [species, expected] of [['fox', 'cinder'], ['sprout', 'moss'], ['frog', 'puddle']] as const) {
    const original = { _id: 'pet', userId: 'user', name: 'Mochi', species, hunger: 60, mood: 80, energy: 60, xp: 400, level: 3, traits: ['flower fan'], updatedAt: 100, points: 80, ownedItems: ['trail-bandana'], equippedItems: { neck: 'trail-bandana' } };
    const resolved = currentPet(original, 100);
    assert.equal(resolved.species, expected);
    assert.deepEqual({ ...resolved, species }, original);
    assert.equal(original.species, species);
  }
});

test('retired accessories can be removed without deleting ownership or changing earned progress', async () => {
  const f = fixture(), a = await f.account();
  await f.store.update('pets', { _id: a.pet._id }, { $set: { points: 180, xp: 500, ownedItems: ['explorer-hat', 'round-glasses'], equippedItems: { head: 'explorer-hat', face: 'round-glasses' } } });
  const catalog = (await f.request('GET', '/api/shop', undefined, a.token)).json().catalog;
  assert.equal(catalog.length, 5);
  assert.ok(catalog.every((item: any) => !['explorer-hat', 'round-glasses'].includes(item.id)));
  for (const slot of ['head', 'face']) assert.equal((await f.request('POST', '/api/shop/equip', { slot, itemId: null }, a.token)).statusCode, 200);
  const saved = (await f.request('GET', '/api/shop', undefined, a.token)).json();
  assert.deepEqual(saved.equippedItems, {});
  assert.deepEqual(saved.ownedItems, ['explorer-hat', 'round-glasses']);
  assert.equal(saved.points, 180);
  assert.equal(saved.pet.xp, 500);
});


test('named accounts preserve a guest pet and authenticate case-insensitively across devices', async () => {
  const f = fixture(), a = await f.account();
  await f.store.update('pets', { _id: a.pet._id }, { $set: { xp: 400, points: 120 } });
  const credentials = { username: 'Trail_Rae', password: 'a-long-test-password' };
  const registered = await f.request('POST', '/api/account/register', credentials, a.token);
  assert.equal(registered.statusCode, 201);
  assert.equal(registered.json().username, 'trail_rae');
  const login = await f.request('POST', '/api/account/login', credentials);
  assert.equal(login.statusCode, 200);
  assert.notEqual(login.json().token, registered.json().token);
  const pet = (await f.request('GET', '/api/pet', undefined, login.json().token)).json().pet;
  assert.equal(pet._id, a.pet._id); assert.equal(pet.xp, 400); assert.equal(pet.points, 120);
  assert.equal((await f.request('POST', '/api/account/login', { ...credentials, password: 'wrong-password' })).statusCode, 401);
  assert.equal((await f.request('POST', '/api/account/register', credentials)).statusCode, 409);
  const row = f.store.rows('users')[0];
  assert.equal(JSON.stringify(row).includes(credentials.password), false);
  assert.equal(row.passwordHash.length, 128);
  assert.equal((await f.request('POST', '/api/account/logout', {}, login.json().token)).statusCode, 200);
  assert.equal((await f.request('GET', '/api/me', undefined, login.json().token)).statusCode, 401);
  assert.equal((await f.request('GET', '/api/me', undefined, registered.json().token)).statusCode, 200);
});

test('six-character passwords work for registration and login, and shorter passwords are rejected', async () => {
  const f = fixture();
  const credentials = { username: 'short_password', password: 'abc123' };
  assert.equal((await f.request('POST', '/api/account/register', { ...credentials, password: 'abc12' })).statusCode, 400);
  assert.equal(f.store.rows('users').length, 0);
  assert.equal((await f.request('POST', '/api/account/register', credentials)).statusCode, 201);
  assert.equal((await f.request('POST', '/api/account/login', credentials)).statusCode, 200);
  assert.equal((await f.request('POST', '/api/account/login', { ...credentials, password: 'abc12' })).statusCode, 400);
  assert.equal((await f.request('POST', '/api/account/login', { ...credentials, password: 'abc124' })).statusCode, 401);
});

test('concurrent username claims have one owner and sessions expire', async () => {
  const f = fixture();
  const credentials = { username: 'wanderer', password: 'a-long-test-password' };
  const claims = await Promise.all([f.request('POST', '/api/account/register', credentials), f.request('POST', '/api/account/register', credentials)]);
  assert.deepEqual(claims.map(response => response.statusCode).sort(), [201, 409]);
  const token = claims.find(response => response.statusCode === 201)!.json().token;
  assert.equal(f.store.rows('users').length, 1);
  assert.equal(f.store.rows('usernames').length, 1);
  f.advance(31 * 86_400_000);
  assert.equal((await f.request('GET', '/api/me', undefined, token)).statusCode, 401);
  assert.equal((await f.request('POST', '/api/account/login', credentials)).statusCode, 200);
});

test('upgrading a guest account keeps an active walk on the new device credential', async () => {
  const f = fixture(), a = await f.account();
  const walk = (await f.request('POST', '/api/walk/start', {}, a.token)).json().walk;
  f.advance(120_000);
  await f.request('POST', '/api/walk/progress', { walkId: walk._id, distanceM: 240, geoCells: [] }, a.token);
  const registered = await f.request('POST', '/api/account/register', { username: 'walking_guest', password: 'a-long-test-password' }, a.token);
  assert.equal(registered.statusCode, 201);
  const token = registered.json().token;
  const continued = (await f.request('GET', '/api/pet', undefined, token)).json().walk;
  assert.equal(continued.trackingHere, true);
  assert.equal(continued.distanceM, 240);
  assert.equal(continued.tracker, undefined);
  assert.equal((await f.request('GET', '/api/pet', undefined, a.token)).json().walk.trackingHere, false);
});

const handoffPreferences = { mode: 'laptop', muted: true, tab: 'companion', line: 'Hello again!', welcome: false, editing: false, setup: { nickname: 'Rae', pace: 'starting', step: 2 } };
test('one journey QR carries account and destination; only the connected phone starts and owns the walk', async () => {
  const f = fixture(), laptop = await f.account(), stranger = await f.account('Fern');
  const destination = { name: 'Riverside Garden', lat: 12.3456, lon: 77.1234 };
  const preferences = { ...handoffPreferences, mode: 'host', journey: { destination } };
  const qr = (await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences }, laptop.token)).json();
  assert.equal(f.store.rows('walks').length, 0);
  f.advance(45_000);
  const code = new URL(qr.url).hash.slice('#continue='.length);
  const connected = (await f.request('POST', '/api/handoff/claim', { code })).json();
  assert.deepEqual(connected.preferences.journey, { destination });
  assert.equal(f.store.rows('walks').length, 0);
  assert.equal((await f.request('GET', '/api/pet', undefined, connected.token)).json().pet._id, laptop.pet._id);
  const started = await f.request('POST', '/api/walk/start', connected.preferences.journey, connected.token);
  assert.equal(started.statusCode, 201);
  const walk = started.json().walk;
  assert.equal(walk.startedAt, Date.UTC(2026, 9, 10, 12) + 45_000);
  assert.equal(walk.trackingHere, true);
  assert.deepEqual(walk.destination, destination);
  assert.equal((await f.request('GET', '/api/pet', undefined, laptop.token)).json().walk.trackingHere, false);
  assert.equal((await f.request('GET', '/api/sync', undefined, stranger.token)).json().walk, null);
  f.advance(60_000);
  const progress = { walkId: walk._id, distanceM: 100, geoCells: ['12.3456,77.1234'] };
  assert.equal((await f.request('POST', '/api/walk/progress', progress, laptop.token)).statusCode, 409);
  assert.equal((await f.request('POST', '/api/walk/progress', progress, connected.token)).statusCode, 200);
  assert.deepEqual((await f.request('GET', '/api/sync', undefined, connected.token)).json().walk.destination, destination);
  const repeat = (await f.request('POST', '/api/walk/start', { destination: { ...destination, name: 'Different garden' } }, connected.token)).json().walk;
  assert.equal(repeat._id, walk._id);
  assert.deepEqual(repeat.destination, destination);
  assert.equal(f.store.rows('walks').length, 1);
  assert.equal((await f.request('POST', '/api/handoff/claim', { code })).statusCode, 410);
});

test('journey handoffs support own routes and validate destinations without accepting URLs or extra fields', async () => {
  const f = fixture(), a = await f.account();
  const preferences = { ...handoffPreferences, mode: 'host', journey: {} };
  const ownRoute = await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences }, a.token);
  assert.equal(ownRoute.statusCode, 200);
  const code = new URL(ownRoute.json().url).hash.slice('#continue='.length);
  const phone = (await f.request('POST', '/api/handoff/claim', { code })).json();
  assert.deepEqual(phone.preferences.journey, {});
  assert.equal((await f.request('POST', '/api/walk/start', phone.preferences.journey, phone.token)).json().walk.destination, undefined);
  for (const destination of [{ name: '', lat: 12, lon: 77 }, { name: 'Garden', lat: 91, lon: 77 }, { name: 'Garden', lat: 12, lon: 77, url: 'javascript:alert(1)' }]) {
    assert.equal((await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: { ...preferences, journey: { destination } } }, a.token)).statusCode, 400);
    assert.equal((await f.request('POST', '/api/walk/start', { destination }, phone.token)).statusCode, 400);
  }
});

test('destination map and directions show the public destination without an account credential or current GPS', () => {
  const destination = { name: 'Garden & pond', lat: 12.3456, lon: 77.1234 };
  const directions = new URL(walkingDirections(destination)), map = new URL(destinationMap(destination));
  assert.equal(directions.searchParams.get('destination'), '12.3456,77.1234');
  assert.equal(directions.searchParams.get('travelmode'), 'walking');
  assert.equal(directions.searchParams.has('origin'), false);
  assert.equal(map.searchParams.get('marker'), '12.3456,77.1234');
  assert.equal(map.origin, 'https://www.openstreetmap.org');
  assert.equal(map.hash, '');
});

test('QR continuation is private, short lived, single use, and restores the same saved account', async () => {
  const f = fixture(), a = await f.account(), b = await f.account('Fern');
  await f.request('POST', '/api/memory', { text: 'A flower by the path', category: 'flower' }, a.token);
  await f.request('POST', '/api/shop/purchase', { itemId: 'trail-bandana' }, a.token);
  const created = await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: handoffPreferences }, a.token);
  assert.equal(created.statusCode, 200);
  const code = new URL(created.json().url).hash.slice('#continue='.length);
  assert.equal(JSON.stringify(f.store.rows('handoffs')).includes(code), false);
  assert.equal((await f.request('POST', '/api/handoff/status', { code }, a.token)).json().used, false);
  assert.equal((await f.request('POST', '/api/handoff/status', { code }, b.token)).statusCode, 404);
  const claimed = await f.request('POST', '/api/handoff/claim', { code });
  assert.equal(claimed.statusCode, 200);
  assert.equal((await f.request('POST', '/api/handoff/status', { code }, a.token)).json().used, true);
  assert.deepEqual(claimed.json().preferences, handoffPreferences);
  const sync = (await f.request('GET', '/api/sync', undefined, claimed.json().token)).json();
  assert.equal(sync.pet._id, a.pet._id);
  assert.equal(sync.pet.equippedItems.neck, 'trail-bandana');
  assert.equal(sync.memories.length, 1);
  assert.equal((await f.request('GET', '/api/sync', undefined, b.token)).json().memories.length, 0);
  assert.equal((await f.request('POST', '/api/handoff/claim', { code })).statusCode, 410);
  const second = (await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: handoffPreferences }, a.token)).json();
  f.advance(120_001);
  assert.equal((await f.request('POST', '/api/handoff/claim', { code: new URL(second.url).hash.slice('#continue='.length) })).statusCode, 410);
});

test('walk checkpoints transfer tracking to the phone without losing distance or rewarding twice', async () => {
  const f = fixture(), a = await f.account();
  const destination = { name: 'Public park', lat: 12.3456, lon: 77.1234 };
  const walk = (await f.request('POST', '/api/walk/start', { destination }, a.token)).json().walk;
  f.advance(120_000);
  const progress = { walkId: walk._id, distanceM: 240, geoCells: ['12.3456,77.1234'] };
  assert.equal((await f.request('POST', '/api/walk/progress', progress, a.token)).statusCode, 200);
  const handoff = (await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: handoffPreferences }, a.token)).json();
  const code = new URL(handoff.url).hash.slice('#continue='.length);
  const claims = await Promise.all([f.request('POST', '/api/handoff/claim', { code }), f.request('POST', '/api/handoff/claim', { code })]);
  assert.deepEqual(claims.map(response => response.statusCode).sort(), [200, 410]);
  const phoneToken = claims.find(response => response.statusCode === 200)!.json().token;
  assert.equal((await f.request('GET', '/api/pet', undefined, a.token)).json().walk.trackingHere, false);
  assert.equal((await f.request('GET', '/api/pet', undefined, phoneToken)).json().walk.distanceM, 240);
  assert.deepEqual((await f.request('GET', '/api/pet', undefined, phoneToken)).json().walk.destination, destination);
  assert.equal((await f.request('POST', '/api/walk/progress', { ...progress, distanceM: 260 }, a.token)).statusCode, 409);
  assert.equal((await f.request('POST', '/api/walk/end', progress, a.token)).statusCode, 409);
  f.advance(60_000);
  assert.equal((await f.request('POST', '/api/walk/progress', { ...progress, distanceM: 300 }, phoneToken)).statusCode, 200);
  assert.equal((await f.request('POST', '/api/walk/progress', progress, phoneToken)).json().walk.distanceM, 300);
  const backOnLaptop = (await f.request('POST', '/api/walk/resume', {}, a.token)).json().walk;
  assert.equal(backOnLaptop.trackingHere, true);
  assert.equal(backOnLaptop.distanceM, 300);
  assert.equal((await f.request('POST', '/api/walk/progress', progress, phoneToken)).statusCode, 409);
  assert.equal((await f.request('POST', '/api/walk/resume', {}, phoneToken)).json().walk.trackingHere, true);
  assert.equal((await f.request('GET', '/api/pet', undefined, a.token)).json().walk.trackingHere, false);
  const finished = await f.request('POST', '/api/walk/end', progress, phoneToken);
  assert.equal(finished.json().reward.xp, 30);
  assert.equal(finished.json().walk.distanceM, 300);
  assert.equal((await f.request('POST', '/api/walk/end', progress, phoneToken)).json().pet.xp, 30);
});

test('personality preferences have a private embedding and update without inventing journal discoveries', async () => {
  const f = fixture(), a = await f.account(), b = await f.account();
  const profile = { nickname: 'Rae', pace: 'starting', interest: 'plants', tone: 'gentle' };
  await f.request('POST', '/api/onboarding', { profile, name: 'Mochi' }, a.token);
  await new Promise(resolve => setImmediate(resolve));
  const bond = f.store.rows('memories').find(row => row.kind === 'bond')!;
  assert.equal(bond.embeddingStatus, 'ready'); assert.equal(bond.embedding.length, 384);
  assert.match(bond.text, /Short, easy wanders/);
  assert.equal((await f.request('GET', '/api/memory', undefined, a.token)).json().memories.length, 0);
  await f.request('POST', '/api/friends', { code: a.friendCode }, b.token);
  assert.equal(JSON.stringify((await f.request('GET', '/api/friends', undefined, b.token)).json()).includes('Short, easy wanders'), false);
  await f.request('PUT', '/api/onboarding', { profile: { ...profile, tone: 'bold', interest: 'water' }, name: 'Mochi' }, a.token);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.rows('memories').filter(row => row.kind === 'bond').length, 1);
  assert.match(f.store.rows('memories')[0].text, /adventure buddy/);
  const context = (await f.request('POST', '/api/context', { text: 'What do we enjoy?' }, a.token)).json();
  assert.match(context.messages[0].content, /ripples/);
  assert.equal((await f.request('GET', '/api/me', undefined, a.token)).json().profile.nickname, 'Rae');
});


test('deleting browser Gemma removes only its own cached files across revisions', async () => {
  const modelUrl = 'https://huggingface.co/' + gemmaModelId + '/resolve/';
  const entries = new Set([
    modelUrl + 'pinned/onnx/decoder_model_merged_q4f16.onnx_data',
    modelUrl + 'old/tokenizer.json',
    'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx',
    'https://huggingface.co/' + gemmaModelId + '-other/resolve/main/model.onnx',
    'https://other.example/' + gemmaModelId + '/resolve/main/model.onnx',
    'https://cdn.example/ort-wasm.wasm',
    'https://pawpath.example/api/me',
  ]);
  const cache = { keys: async () => [...entries].map(url => new Request(url)), delete: async (request: Request) => entries.delete(request.url) };
  const storage = { has: async (name: string) => name === 'transformers-cache', open: async (name: string) => { assert.equal(name, 'transformers-cache'); return cache; } } as unknown as CacheStorage;
  assert.equal(await hasDownloadedModel(storage), true);
  await deleteDownloadedModel(storage);
  assert.equal(await hasDownloadedModel(storage), false);
  assert.equal(entries.size, 5);
  assert.equal(entries.has('https://pawpath.example/api/me'), true);
  await deleteDownloadedModel(storage);
  assert.equal(entries.size, 5);
});

test('model cache deletion handles missing caches and reports storage failures', async () => {
  const missing = { has: async () => false, open: async () => { throw new Error('Must not create a cache'); } } as unknown as CacheStorage;
  assert.equal(await hasDownloadedModel(missing), false);
  await deleteDownloadedModel(missing);
  const denied = { has: async () => { throw new Error('Storage denied'); } } as unknown as CacheStorage;
  await assert.rejects(deleteDownloadedModel(denied), /Storage denied/);
  const stuck = { has: async () => true, open: async () => ({ keys: async () => [new Request('https://huggingface.co/' + gemmaModelId + '/resolve/main/config.json')], delete: async () => false }) } as unknown as CacheStorage;
  await assert.rejects(deleteDownloadedModel(stuck), /could not be deleted/);
});

test('automatic Gemma wake requires complete weights for the pinned revision, not partial or old downloads', async () => {
  const base = `https://huggingface.co/${gemmaModelId}/resolve/`;
  const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'processor_config.json', 'preprocessor_config.json', ...['audio_encoder', 'decoder_model_merged', 'embed_tokens', 'vision_encoder'].flatMap(name => [`onnx/${name}_q4f16.onnx`, `onnx/${name}_q4f16.onnx_data`])];
  const entries = new Set(files.map(file => base + 'old/' + file));
  entries.add(base + gemmaRevision + '/config.json');
  const storage = { has: async () => true, open: async () => ({ keys: async () => [...entries].map(url => new Request(url)), delete: async (request: Request) => entries.delete(request.url) }) } as unknown as CacheStorage;
  assert.equal(await hasDownloadedModel(storage), true);
  assert.equal(await hasInstalledModel(storage), false);
  for (const file of files) entries.add(base + gemmaRevision + '/' + file);
  assert.equal(await hasInstalledModel(storage), true);
  entries.delete(base + gemmaRevision + '/onnx/vision_encoder_q4f16.onnx_data');
  assert.equal(await hasInstalledModel(storage), false);
  await deleteDownloadedModel(storage);
  assert.equal(await hasInstalledModel(storage), false);
});

test('cached Gemma waking cannot fetch missing model weights but permits runtime resources', async () => {
  const fetched: string[] = [];
  const fetcher = cachedModelFetch(async input => { fetched.push(String(input)); return new Response('runtime'); });
  const modelUrl = `https://huggingface.co/${gemmaModelId}/resolve/${gemmaRevision}/onnx/decoder_model_merged_q4f16.onnx_data`;
  assert.equal((await fetcher(modelUrl)).status, 404);
  assert.equal((await fetcher(new Request(modelUrl))).status, 404);
  assert.equal(fetched.length, 0);
  assert.equal(await (await fetcher('https://cdn.example/ort-wasm.wasm')).text(), 'runtime');
  assert.deepEqual(fetched, ['https://cdn.example/ort-wasm.wasm']);
});

test('cached Gemma resolves default-branch tokenizer metadata to the installed pinned files', async () => {
  const base = `https://huggingface.co/${gemmaModelId}/resolve/`;
  const saved = new Map([
    [base + gemmaRevision + '/tokenizer_config.json', JSON.stringify({ tokenizer_class: 'GemmaTokenizer' })],
    [base + gemmaRevision + '/chat_template.jinja', 'saved template'],
    [base + 'main/tokenizer_config.json', JSON.stringify({ tokenizer_class: 'WrongRevision' })],
  ]);
  const matched: string[] = [];
  const storage = { has: async () => true, open: async () => ({ match: async (url: string) => {
    matched.push(url);
    const value = saved.get(url);
    return value === undefined ? undefined : new Response(value);
  } }) } as unknown as CacheStorage;
  const fetcher = cachedModelFetch(async () => { throw new Error('Saved Gemma must not download again'); }, storage);
  const metadata = await fetcher(base + 'main/tokenizer_config.json', { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
  assert.equal(metadata.ok, true);
  assert.equal((await metadata.json()).tokenizer_class, 'GemmaTokenizer');
  assert.equal(await (await fetcher(new Request(base + gemmaRevision + '/chat_template.jinja'))).text(), 'saved template');
  assert.equal((await fetcher(base + 'main/onnx/decoder_model_merged_q4f16.onnx_data')).status, 404);
  assert.deepEqual(matched, [base + gemmaRevision + '/tokenizer_config.json', base + gemmaRevision + '/chat_template.jinja', base + gemmaRevision + '/onnx/decoder_model_merged_q4f16.onnx_data']);
});

test('handhelds use the computer host even if the browser exposes WebGPU', async () => {
  assert.equal(isHandheld({ userAgent: 'Mozilla iPhone', platform: 'iPhone', maxTouchPoints: 5 } as Navigator), true);
  assert.equal(isHandheld({ userAgent: 'Mozilla Android', platform: 'Linux', maxTouchPoints: 5 } as Navigator), true);
  assert.equal(isHandheld({ userAgent: 'Mozilla Macintosh', platform: 'MacIntel', maxTouchPoints: 5 } as Navigator), true);
  assert.equal(isHandheld({ userAgent: 'Mozilla Macintosh', platform: 'MacIntel', maxTouchPoints: 0 } as Navigator), false);
  const previous = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  try {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla iPhone' });
    assert.deepEqual(await browserSupport(), { text: 'unavailable', vision: 'unavailable' });
  } finally { if (previous) Object.defineProperty(navigator, 'userAgent', previous); else delete (navigator as any).userAgent; }
});

test('starting location rejects local HTTP before requesting permission and distinguishes browser failures', async () => {
  let requests = 0;
  const geo = { getCurrentPosition: () => { requests++; } } as unknown as Geolocation;
  await assert.rejects(locate(geo, false), /needs HTTPS/);
  assert.equal(requests, 0);
  await assert.rejects(locate(undefined, true), /Location is unavailable/);
  for (const [code, message] of [[1, /Location is blocked/], [2, /could not find its location/], [3, /GPS took too long/]] as const) {
    const denied = { getCurrentPosition: (_success: PositionCallback, fail: PositionErrorCallback) => fail({ code } as GeolocationPositionError) } as unknown as Geolocation;
    await assert.rejects(locate(denied, true), message);
  }
  const broken = { getCurrentPosition: () => { throw new Error('Scanner browser refused'); } } as unknown as Geolocation;
  await assert.rejects(locate(broken, true), /Use Safari or Chrome/);
});

test('starting location has a permission deadline, ignores late responses and can be retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callback: PositionCallback = () => {}, starts = 0;
  const geo = { getCurrentPosition: (success: PositionCallback) => { callback = success; } } as unknown as Geolocation;
  const attempt = locate(geo, true).then(() => { starts++; });
  const failed = assert.rejects(attempt, /Location did not respond/);
  t.mock.timers.tick(20_000);
  await failed;
  callback({ timestamp: 1 } as GeolocationPosition);
  await Promise.resolve();
  assert.equal(starts, 0);
  const retry = locate(geo, true).then(() => { starts++; });
  callback({ timestamp: 2 } as GeolocationPosition);
  await retry;
  t.mock.timers.tick(20_000);
  assert.equal(starts, 1);
});

test('walk GPS discards background travel and resets its fix when the phone returns', () => {
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  let callback: PositionCallback = () => {}, cleared = false;
  const geolocation = { watchPosition: (next: PositionCallback) => { callback = next; return 42; }, clearWatch: (id: number) => { assert.equal(id, 42); cleared = true; } } as Geolocation;
  let meters = 0;
  const stop = watchWalk(step => meters += step, () => {}, geolocation, visibility as Document);
  const fix = (lon: number, timestamp: number) => callback({ coords: { latitude: 12, longitude: lon, accuracy: 5 }, timestamp } as GeolocationPosition);
  fix(77, 1_000); fix(77.0001, 11_000);
  assert.ok(meters > 10);
  const before = meters;
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  fix(77.0004, 21_000);
  assert.equal(meters, before);
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  fix(77.0005, 31_000);
  assert.equal(meters, before);
  fix(77.0006, 41_000);
  assert.ok(meters > before);
  stop(); assert.equal(cleared, true);
});

test('an unavailable phone geolocation API leaves the restored walk usable with a clear message', () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  let message = '';
  try {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    const stop = watchWalk(() => { throw new Error('No GPS samples expected'); }, text => message = text, undefined, visibility as Document);
    assert.match(message, /HTTPS/); stop();
  } finally { if (previous) Object.defineProperty(navigator, 'geolocation', previous); else delete (navigator as any).geolocation; }
});

test('walk screen wake lock releases on stop, reacquires on return, and handles browser refusal', async () => {
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const locks: any[] = [], states: boolean[] = [];
  const wakeLock = { request: async () => {
    const lock = Object.assign(new EventTarget(), { released: false, release: async () => { lock.released = true; lock.dispatchEvent(new Event('release')); } });
    locks.push(lock); return lock;
  } } as unknown as WakeLock;
  const stop = keepWalkAwake(awake => states.push(awake), wakeLock, visibility as Document);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1), true);
  visibility.hidden = true; await locks[0].release(); visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(states.at(-1), false); assert.equal(locks.length, 1);
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(locks.length, 2); assert.equal(states.at(-1), true);
  stop(); assert.equal(locks[1].released, true); assert.equal(states.at(-1), false);
  const refused = keepWalkAwake(awake => states.push(awake), { request: async () => { throw new Error('Low battery'); } } as unknown as WakeLock, visibility as Document);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1), false); refused();
});

test('browser Gemma requires WebGPU and half-precision GPU support', async () => {
  const globals = globalThis as any, oldSecure = globals.isSecureContext;
  const previous = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  try {
    globals.isSecureContext = true;
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } });
    assert.deepEqual(await browserSupport(), { text: 'downloadable', vision: 'downloadable' });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set() }) } });
    assert.equal((await browserSupport()).text, 'unavailable');
    globals.isSecureContext = false;
    assert.equal((await browserSupport()).text, 'unavailable');
  } finally {
    if (previous) Object.defineProperty(navigator, 'gpu', previous); else delete (navigator as any).gpu;
    if (oldSecure === undefined) delete globals.isSecureContext; else globals.isSecureContext = oldSecure;
  }
});

test('Gemma worker carries context and images, reports download progress, and rejects pending work on sleep', async () => {
  const worker = new EventTarget() as any;
  let posted: any, stopped = 0;
  worker.postMessage = (data: any) => { posted = data; };
  worker.terminate = () => stopped++;
  const client = new GemmaClient(() => worker);
  const send = (data: any) => worker.dispatchEvent(new MessageEvent('message', { data }));
  let progress = 0;
  await assert.rejects(client.generate([{ role: 'user', content: 'Hello' }]), /Wake Gemma/);
  const loading = client.load(value => progress = value);
  assert.equal(client.state, 'downloading');
  send({ id: posted.id, type: 'progress', progress: .6 }); assert.equal(progress, .6);
  await assert.rejects(client.load(() => {}), /already waking/);
  send({ id: posted.id, type: 'ready' }); await loading;
  assert.equal(client.state, 'available');
  const messages: any = [{ role: 'system', content: 'Private bond context' }, { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
  const reply = client.generate(messages); assert.deepEqual(posted.messages, messages);
  send({ id: posted.id, type: 'result', text: 'A flower.' }); assert.equal(await reply, 'A flower.');
  const failing = client.generate([{ role: 'user', content: 'Hello' }]);
  send({ id: posted.id, type: 'error', message: 'GPU lost' }); await assert.rejects(failing, /GPU lost/);
  const pending = client.generate([{ role: 'user', content: 'Hello' }]); client.stop();
  await assert.rejects(pending, /sleep/); assert.equal(client.state, 'downloadable'); assert.equal(stopped, 1);
});

test('cached Gemma loading reports warmup separately and becomes available only after it succeeds', async () => {
  const worker = new EventTarget() as any;
  let posted: any;
  worker.postMessage = (data: any) => { posted = data; };
  worker.terminate = () => {};
  const client = new GemmaClient(() => worker), phases: string[] = [];
  const send = (data: any) => worker.dispatchEvent(new MessageEvent('message', { data }));
  const loading = client.load(() => {}, true, phase => phases.push(phase));
  assert.equal(posted.cachedOnly, true);
  send({ id: posted.id, type: 'phase', phase: 'loading' });
  send({ id: posted.id, type: 'progress', progress: 1 });
  assert.equal(client.state, 'downloading');
  send({ id: posted.id, type: 'phase', phase: 'warming' });
  assert.equal(client.state, 'downloading');
  await assert.rejects(client.generate([{ role: 'user', content: 'Hello' }]), /Wake Gemma/);
  send({ id: posted.id, type: 'ready' });
  await loading;
  assert.equal(client.state, 'available');
  assert.deepEqual(phases, ['loading', 'warming']);
  client.stop();
  const retry = client.load(() => {}, true);
  const failed = assert.rejects(retry, /Saved model missing/);
  send({ id: posted.id, type: 'error', fatal: true, message: 'Saved model missing' });
  await failed;
  assert.equal(client.state, 'downloadable');
});

test('account deletion revokes every browser session and unused QR, releasing the username', async () => {
  const f = fixture();
  const credentials = { username: 'deletion_test', password: 'a-long-test-password' };
  const token = (await f.request('POST', '/api/account/register', credentials)).json().token;
  const second = (await f.request('POST', '/api/account/login', credentials)).json().token;
  const handoff = (await f.request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: handoffPreferences }, token)).json();
  assert.equal((await f.request('DELETE', '/api/account', undefined, token)).statusCode, 200);
  assert.equal((await f.request('GET', '/api/me', undefined, second)).statusCode, 401);
  assert.equal((await f.request('POST', '/api/handoff/claim', { code: new URL(handoff.url).hash.slice('#continue='.length) })).statusCode, 410);
  assert.equal((await f.request('POST', '/api/account/register', credentials)).statusCode, 201);
});
