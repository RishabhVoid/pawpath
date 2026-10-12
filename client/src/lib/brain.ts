import { api, post, ApiError } from './api.js';
import type { BrainMode, ChatInput, Status, VisionResult, Place, Category } from '../../../shared/types.js';
import { shortLine } from '../../../shared/pet.js';
import { readVision } from '../../../shared/vision.js';
import { browserCompletion } from './browser-ai.js';
import { hostedCompletion } from './browser-host.js';
import { visionPrompt } from '../../../shared/prompt.js';
import { placePrompt, readPlaceChoice } from '../../../shared/places.js';

export type Pairing = { url: string; token: string; model: string };
export const getPairing = (): Pairing | null => { try { return JSON.parse(localStorage.getItem('pawpath.pairing') || 'null'); } catch { return null; } };
export function savePairing(link: string) {
  const parsed = new URL(link);
  const encoded = new URLSearchParams(parsed.hash.slice(1)).get('pair');
  if (!encoded) throw new Error('Paste the full pairing link from your laptop helper.');
  const data = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as Pairing;
  const url = new URL(data.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Your laptop bridge needs an HTTPS address.');
  if (url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(data.token) || !/^gemma4(?::|$)/.test(data.model)) throw new Error('This pairing link is invalid.');
  data.url = url.origin;
  localStorage.setItem('pawpath.pairing', JSON.stringify(data));
  return data;
}
async function bridge(pairing: Pairing, messages: ChatInput[], vision = false) {
  const response = await fetch(pairing.url + '/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(vision ? 65_000 : 25_000), headers: { 'Content-Type': 'application/json', 'X-Pairing-Token': pairing.token, 'ngrok-skip-browser-warning': 'true' }, body: JSON.stringify({ messages, vision }) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.message || 'Your laptop could not answer.', response.status, data.reason);
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Your laptop returned an empty reply.');
  return text;
}
export async function brainChat(text: string, mode: BrainMode, _status?: Status | null): Promise<{ line: string; mode: BrainMode }> {
  if (mode === 'browser' || mode === 'host') {
    const context = await post<{ messages: ChatInput[] }>('/context', { text });
    return { line: shortLine(await (mode === 'host' ? hostedCompletion(context.messages) : browserCompletion(context.messages))), mode };
  }
  const pairing = getPairing();
  if (!pairing) return post('/local/chat', { text });
  const context = await post<{ messages: ChatInput[] }>('/context', { text });
  return { line: shortLine(await bridge(pairing, context.messages)), mode: 'laptop' };
}
export async function brainVision(image: string, mode: BrainMode, keepPhoto = false): Promise<VisionResult> {
  if (mode === 'browser' || mode === 'host') {
    const result = readVision(await (mode === 'host' ? hostedCompletion : browserCompletion)([{ role: 'user', content: [{ type: 'text', text: visionPrompt }, { type: 'image_url', image_url: { url: image } }] }], true));
    if (result.is_outdoor && !result.is_screen) await post('/memory', { text: result.label, category: result.category, ...(keepPhoto ? { image } : {}) });
    return result;
  }
  const pairing = getPairing();
  if (!pairing) return (await post<{ result: VisionResult }>('/local/vision', { image, keepPhoto })).result;
  const result = readVision(await bridge(pairing, [{ role: 'user', content: [{ type: 'text', text: visionPrompt }, { type: 'image_url', image_url: { url: image } }] }], true));
  if (result.is_outdoor && !result.is_screen) await post('/memory', { text: result.label, category: result.category, ...(keepPhoto ? { image } : {}) });
  return result;
}
export async function brainPlace(places: Place[], seen: Category[], mode: BrainMode, status: Status | null) {
  const candidates = places.slice(0, 3);
  const reply = await brainChat(placePrompt(candidates, seen), mode, status);
  const choice = readPlaceChoice(reply.line, candidates);
  return { ...reply, place: choice.place, line: shortLine(choice.place.name.split(/\s+/).slice(0, 8).join(' ') + ' · ' + (choice.place.distanceM / 1000).toFixed(1) + ' km away. ' + choice.reason) };
}
export async function laptopHealth() {
  const pair = getPairing();
  if (!pair) return (await api<Status>('/health')).localBrain;
  try { return (await fetch(pair.url + '/health', { signal: AbortSignal.timeout(3000), headers: { 'X-Pairing-Token': pair.token, 'ngrok-skip-browser-warning': 'true' } })).ok; } catch { return false; }
}
