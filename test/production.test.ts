import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inject } from 'light-my-request';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { DevelopmentStore } from '../server/store.js';

config.production = true;

test('production serves the built game, worker, WASM, PWA assets, and SPA routes from one origin', async () => {
  const app = createApp(new DevelopmentStore());
  const request = (url: string) => inject(app as any, { method: 'GET', url });
  const index = await readFile('client/dist/index.html', 'utf8');
  for (const url of ['/', '/pets', '/some-client-route']) {
    const response = await request(url);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type']!, /text\/html/);
    assert.equal(response.body, index);
  }
  const js = index.match(/src="(\/assets\/[^" ]+\.js)"/)![1];
  const css = index.match(/href="(\/assets\/[^" ]+\.css)"/)![1];
  const bundle = await request(js);
  assert.equal(bundle.statusCode, 200);
  assert.match(bundle.headers['content-type']!, /javascript/);
  assert.equal(bundle.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(css)).statusCode, 200);
  const workerPath = bundle.body.match(/\/assets\/gemma\.worker-[^" ]+\.js/)![0];
  const worker = await request(workerPath);
  assert.equal(worker.statusCode, 200);
  assert.match(worker.headers['content-type']!, /javascript/);
  const wasmPath = worker.body.match(/\/assets\/ort-wasm-[^" ]+\.wasm/)![0];
  const wasm = await request(wasmPath);
  assert.equal(wasm.statusCode, 200);
  assert.equal(wasm.headers['content-type'], 'application/wasm');
  for (const path of ['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/fonts/dm-sans-latin.woff2', '/art/pets-preview/simple-trail.webp']) assert.equal((await request(path)).statusCode, 200);
  assert.equal((await request('/assets/missing-worker.js')).statusCode, 404);
  const missingApi = await request('/api/missing');
  assert.equal(missingApi.statusCode, 401);
  assert.match(missingApi.headers['content-type']!, /application\/json/);
  assert.equal((await request('/api/local/chat')).statusCode, 401);
});

test('production preserves private recall while Atlas builds its index and recovers when it becomes ready', async () => {
  const store = new DevelopmentStore();
  let atlasReady = false, embeddingReady = true;
  const vector = [1, ...Array(383).fill(0)];
  store.vector = async petId => {
    if (!atlasReady) throw new Error('Index is still building');
    store.vectorReady = true;
    return (await store.find('memories', { petId, embeddingStatus: 'ready' })).map(row => ({ ...row, score: 1 }));
  };
  const app = createApp(store, { embed: async () => { if (!embeddingReady) throw new Error('Embedding unavailable'); return vector; } });
  const request = (method: string, url: string, payload?: unknown, token?: string) => inject(app as any, { method: method as any, url, ...(payload ? { payload } : {}), headers: token ? { authorization: 'Bearer ' + token } : {} });
  const credentials = { username: 'release_walker', password: 'test12' };
  const account = await request('POST', '/api/account/register', credentials);
  assert.equal(account.statusCode, 201);
  const token = account.json().token;
  const setup = await request('POST', '/api/onboarding', { profile: { nickname: 'Rae', pace: 'starting', interest: 'plants', tone: 'gentle' }, name: 'Fern' }, token);
  assert.equal(setup.statusCode, 201);
  const petId = setup.json().pet._id;
  await store.insert('memories', { _id: 'release-flower', petId, text: 'A yellow flower by the path', category: 'flower', embedding: vector, embeddingStatus: 'ready', createdAt: Date.now() });
  await store.insert('memories', { _id: 'stranger-secret', petId: 'another-account', text: 'A stranger secret', category: 'water', embedding: vector, embeddingStatus: 'ready', createdAt: Date.now() });
  const fallback = await request('POST', '/api/context', { text: 'Remember the flower?' }, token);
  assert.equal(fallback.statusCode, 200);
  assert.ok(fallback.json().memories.some((memory: any) => memory._id === 'release-flower'));
  assert.ok(!fallback.body.includes('stranger secret'));
  assert.equal(store.vectorReady, false);
  atlasReady = true;
  assert.equal((await request('POST', '/api/context', { text: 'Remember the flower?' }, token)).statusCode, 200);
  assert.equal(store.vectorReady, true);
  embeddingReady = false;
  const withoutRecall = await request('POST', '/api/context', { text: 'Say hello' }, token);
  assert.equal(withoutRecall.statusCode, 200);
  assert.deepEqual(withoutRecall.json().memories, []);
  assert.match(withoutRecall.json().messages[0].content, /calm, reassuring/);
  assert.equal((await request('POST', '/api/local/chat', { text: 'Hello' }, token)).statusCode, 404);
  const login = await request('POST', '/api/account/login', credentials);
  assert.equal(login.statusCode, 200);
  assert.equal((await request('GET', '/api/pet', undefined, login.json().token)).json().pet._id, petId);
  const handoff = await request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences: { mode: 'host', muted: true, tab: 'companion', line: '', welcome: false, editing: false, journey: { destination: { name: 'Garden', lat: 12, lon: 77 } } } }, token);
  assert.equal(handoff.statusCode, 200);
  assert.equal(new URL(handoff.json().url).origin, 'https://pawpath.example');
  const code = new URLSearchParams(new URL(handoff.json().url).hash.slice(1)).get('continue');
  const claim = await request('POST', '/api/handoff/claim', { code });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().preferences.journey.destination.name, 'Garden');
  assert.equal((await request('GET', '/api/pet', undefined, claim.json().token)).json().pet._id, petId);
});
