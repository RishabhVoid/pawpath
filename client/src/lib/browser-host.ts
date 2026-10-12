import { api, post, ApiError } from './api.js';
import { browserCompletion, browserSupport, sleepGemma } from './browser-ai.js';
import type { ChatInput } from '../../../shared/types.js';

export type HostStatus = { online: boolean; hostingHere: boolean; model: string };
let hosting: { id: string; controller: AbortController } | undefined;
let wakeLock: { release: () => Promise<void> } | undefined;
export async function hostStatus(): Promise<HostStatus> {
  const { hostId, ...status } = await api<HostStatus & { hostId: string | null }>('/ai/status');
  return { ...status, hostingHere: Boolean(hosting && hostId === hosting.id) };
}
async function stayAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
export async function startHosting() {
  if (hosting) return;
  const { hostId } = await post<{ hostId: string }>('/ai/host');
  const session = { id: hostId, controller: new AbortController() }; hosting = session;
  await stayAwake();
  void serve(session);
}
async function serve(session: NonNullable<typeof hosting>) {
  while (hosting === session && !session.controller.signal.aborted) {
    try {
      const { job } = await api<{ job: { id: string; messages: ChatInput[]; vision: boolean } | null }>('/ai/host/' + session.id + '/next', { signal: session.controller.signal });
      if (!job || hosting !== session) continue;
      // Heartbeats keep a slow photo check from making the host appear asleep.
      const heartbeat = setInterval(() => { if (hosting === session) void post('/ai/host', { hostId: session.id }).catch(() => {}); }, 15_000);
      let result: { text: string } | { failed: true };
      try { result = { text: await browserCompletion(job.messages, job.vision) }; }
      catch { result = { failed: true }; }
      finally { clearInterval(heartbeat); }
      if (hosting === session) await post('/ai/host/' + session.id + '/result', { id: job.id, ...result });
      if ('failed' in result && (await browserSupport()).text !== 'available') { stopHosting(); break; }
    } catch (error) {
      if (hosting !== session || session.controller.signal.aborted) break;
      if (error instanceof ApiError && [401, 404].includes(error.status)) { stopHosting(); break; }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}
export function stopHosting() {
  const previous = hosting; hosting = undefined;
  if (previous) { previous.controller.abort(); void api('/ai/host/' + previous.id, { method: 'DELETE' }).catch(() => {}); }
  void wakeLock?.release(); wakeLock = undefined;
}
export function sleepHost() { stopHosting(); sleepGemma(); }
const modelChannel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pawpath-model-control') : undefined;
modelChannel?.addEventListener('message', event => { if (event.data?.type === 'delete-model') sleepHost(); });
export function stopBrowserHosts() { modelChannel?.postMessage({ type: 'delete-model' }); sleepHost(); }
export async function hostedCompletion(messages: ChatInput[], vision = false) {
  const { id } = await post<{ id: string }>('/ai/jobs', { messages, vision });
  const deadline = Date.now() + 115_000;
  try {
    while (Date.now() < deadline) {
      const result = await api<{ state: string; text?: string }>('/ai/jobs/' + id);
      if (result.state === 'done' && result.text) return result.text;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Your laptop took too long to answer. Check that its Pawpath tab is open and awake.');
  } finally { void api('/ai/jobs/' + id, { method: 'DELETE' }).catch(() => {}); }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', stopHosting);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && hosting) void stayAwake(); });
}
