import test from 'node:test';
import assert from 'node:assert/strict';
import { inject } from 'light-my-request';
import { createApp } from '../server/app.js';
import { DevelopmentStore } from '../server/store.js';

async function fixture() {
  let time = Date.UTC(2026, 9, 12);
  const store = new DevelopmentStore();
  const app = createApp(store, { now: () => time, embed: async () => Array(384).fill(0), completion: async () => 'Hi' });
  const request = (method: string, url: string, body?: unknown, token?: string) => inject(app as any, { method: method as any, url, ...(body ? { payload: body } : {}), headers: token ? { authorization: 'Bearer ' + token } : {} });
  const laptop = (await request('POST', '/api/account', {})).json().token;
  const stranger = (await request('POST', '/api/account', {})).json().token;
  const preferences = { mode: 'host', muted: true, tab: 'companion', line: '', welcome: false, editing: false };
  const handoff = (await request('POST', '/api/handoff', { origin: 'https://pawpath.example', preferences }, laptop)).json();
  const code = new URLSearchParams(new URL(handoff.url).hash.slice(1)).get('continue');
  const phone = (await request('POST', '/api/handoff/claim', { code })).json().token;
  const hostId = (await request('POST', '/api/ai/host', {}, laptop)).json().hostId;
  return { request, store, laptop, phone, stranger, hostId, advance: (ms: number) => { time += ms; } };
}
const messages = [{ role: 'system', content: 'Private companion context' }, { role: 'user', content: 'Hello' }];

test('browser host and phone relay share an account, with separate host and requester permissions', async () => {
  const f = await fixture();
  assert.equal((await f.request('GET', '/api/ai/status')).statusCode, 401);
  assert.deepEqual((await f.request('GET', '/api/ai/status', undefined, f.phone)).json(), { online: true, hostingHere: false, hostId: f.hostId, model: 'Gemma 4 E2B' });
  assert.equal((await f.request('GET', '/api/ai/status', undefined, f.laptop)).json().hostingHere, true);
  assert.equal((await f.request('GET', '/api/ai/status', undefined, f.stranger)).json().online, false);
  assert.equal((await f.request('GET', '/api/ai/host/' + f.hostId + '/next', undefined, f.phone)).statusCode, 404);
  assert.equal((await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.stranger)).statusCode, 503);
  const created = await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.phone);
  assert.equal(created.statusCode, 202); const id = created.json().id;
  assert.equal((await f.request('GET', '/api/ai/jobs/' + id, undefined, f.laptop)).statusCode, 404);
  assert.equal((await f.request('GET', '/api/ai/jobs/' + id, undefined, f.stranger)).statusCode, 404);
  const next = await f.request('GET', '/api/ai/host/' + f.hostId + '/next', undefined, f.laptop);
  assert.equal(next.statusCode, 200); assert.deepEqual(next.json().job, { id, messages, vision: false });
  assert.equal((await f.request('POST', '/api/ai/host/' + f.hostId + '/result', { id, text: 'Hello, wanderer.' }, f.phone)).statusCode, 404);
  assert.equal((await f.request('POST', '/api/ai/host/' + f.hostId + '/result', { id, text: 'Hello, wanderer.' }, f.laptop)).statusCode, 200);
  assert.equal((await f.request('POST', '/api/ai/host/' + f.hostId + '/result', { id, text: 'Duplicate.' }, f.laptop)).statusCode, 409);
  assert.deepEqual((await f.request('GET', '/api/ai/jobs/' + id, undefined, f.phone)).json(), { state: 'done', text: 'Hello, wanderer.' });
  assert.equal((await f.request('GET', '/api/ai/jobs/' + id, undefined, f.phone)).statusCode, 404);
  await f.request('DELETE', '/api/ai/host/' + f.hostId, undefined, f.laptop);
});

test('host long-poll wakes when a phone request arrives; concurrent claims get different jobs', async () => {
  const f = await fixture();
  const waiting = f.request('GET', '/api/ai/host/' + f.hostId + '/next', undefined, f.laptop);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request('GET', '/api/ai/host/' + f.hostId + '/next', undefined, f.laptop)).statusCode, 409);
  const first = (await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.phone)).json().id;
  assert.equal((await waiting).json().job.id, first);
  const ids = await Promise.all([1, 2].map(async () => (await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.phone)).json().id));
  const claimed = await Promise.all([1, 2].map(() => f.request('GET', '/api/ai/host/' + f.hostId + '/next', undefined, f.laptop)));
  assert.deepEqual(new Set(claimed.map(reply => reply.json().job.id)), new Set(ids));
  assert.equal((await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.phone)).statusCode, 429);
  await f.request('DELETE', '/api/ai/host/' + f.hostId, undefined, f.laptop);
});

test('photos are bounded transient messages, never stored in Mongo collections', async () => {
  const f = await fixture();
  const image = 'data:image/jpeg;base64,AAAA';
  const photoMessages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: 'Identify this discovery.' }] }];
  assert.equal((await f.request('POST', '/api/ai/jobs', { messages: photoMessages, vision: false }, f.phone)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/ai/jobs', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.example/photo' } }] }], vision: true }, f.phone)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/ai/jobs', { messages: Array(6).fill(messages[1]), vision: false }, f.phone)).statusCode, 400);
  const id = (await f.request('POST', '/api/ai/jobs', { messages: photoMessages, vision: true }, f.phone)).json().id;
  const next = (await f.request('GET', '/api/ai/host/' + f.hostId + '/next', undefined, f.laptop)).json();
  assert.deepEqual(next.job.messages, photoMessages);
  assert.equal(JSON.stringify(['users', 'sessions', 'handoffs', 'memories', 'usageCounters'].flatMap(name => f.store.rows(name))).includes(image), false);
  await f.request('DELETE', '/api/ai/jobs/' + id, undefined, f.phone);
  assert.equal((await f.request('POST', '/api/ai/host/' + f.hostId + '/result', { id, text: 'A flower' }, f.laptop)).statusCode, 409);
  await f.request('DELETE', '/api/ai/host/' + f.hostId, undefined, f.laptop);
});

test('sleep, stale hosts, replaced tabs, logout, and expired jobs cannot leave live access', async () => {
  const f = await fixture();
  const id = (await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.phone)).json().id;
  f.advance(45_000);
  assert.equal((await f.request('GET', '/api/ai/status', undefined, f.phone)).json().online, false);
  assert.equal((await f.request('GET', '/api/ai/jobs/' + id, undefined, f.phone)).statusCode, 503);
  assert.equal((await f.request('POST', '/api/ai/host', { hostId: f.hostId }, f.laptop)).statusCode, 404);
  const newHost = (await f.request('POST', '/api/ai/host', {}, f.laptop)).json().hostId;
  f.advance(30_000);
  assert.equal((await f.request('POST', '/api/ai/host', { hostId: newHost }, f.laptop)).statusCode, 200);
  f.advance(30_000);
  assert.equal((await f.request('GET', '/api/ai/status', undefined, f.phone)).json().online, true);
  const replacement = (await f.request('POST', '/api/ai/host', {}, f.laptop)).json().hostId;
  assert.notEqual(replacement, newHost);
  assert.equal((await f.request('DELETE', '/api/ai/host/' + newHost, undefined, f.laptop)).statusCode, 404);
  const expiring = (await f.request('POST', '/api/ai/jobs', { messages, vision: false }, f.phone)).json().id;
  f.advance(120_000);
  assert.equal((await f.request('GET', '/api/ai/jobs/' + expiring, undefined, f.phone)).statusCode, 404);
  await f.request('POST', '/api/ai/host', {}, f.laptop);
  await f.request('POST', '/api/account/logout', {}, f.laptop);
  assert.equal((await f.request('GET', '/api/ai/status', undefined, f.phone)).json().online, false);
});
