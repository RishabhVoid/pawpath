import type { ChatInput } from '../../../shared/types.js';
import { isHandheld } from './device.js';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type WorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener'>;
export type GemmaPhase = 'loading' | 'downloading' | 'warming' | 'connecting';
type Pending = { resolve: (value: string) => void; reject: (error: Error) => void; progress?: (value: number) => void; phase?: (value: GemmaPhase) => void; timer: ReturnType<typeof setTimeout> };
export class GemmaClient {
  private worker?: WorkerPort;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  state: Availability = 'downloadable';
  constructor(private makeWorker: () => WorkerPort) {}
  private request(type: 'load' | 'generate', messages?: ChatInput[], progress?: (value: number) => void, cachedOnly = false, phase?: (value: GemmaPhase) => void): Promise<string> {
    if (!this.worker) {
      this.worker = this.makeWorker();
      this.worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data, pending = this.pending.get(data.id);
        if (!pending) return;
        if (data.type === 'progress') { pending.progress?.(Math.min(1, Math.max(0, data.progress))); return; }
        if (data.type === 'phase') { pending.phase?.(data.phase); return; }
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.type === 'error') { this.state = data.fatal ? 'downloadable' : this.state; pending.reject(new Error(data.message)); }
        else { if (data.type === 'ready') this.state = 'available'; pending.resolve(data.text || ''); }
      });
      this.worker.addEventListener('error', () => this.stop('Gemma could not run here. Try desktop Chrome or Edge with enough GPU memory.'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(type === 'load' ? 'The model download took too long. Check your connection and try again.' : 'Gemma took too long to answer. Wake it again and retry.'), type === 'load' ? 1_200_000 : 100_000);
      this.pending.set(id, { resolve, reject, progress, phase, timer });
      this.worker!.postMessage({ id, type, messages, cachedOnly });
    });
  }
  async load(progress: (value: number) => void, cachedOnly = false, phase?: (value: GemmaPhase) => void) {
    if (this.state === 'available') return;
    if (this.state === 'downloading') throw new Error('Gemma is already waking up.');
    this.state = 'downloading';
    try { await this.request('load', undefined, progress, cachedOnly, phase); }
    catch (error) { this.stop(); throw error; }
  }
  generate(messages: ChatInput[]) {
    if (this.state !== 'available') return Promise.reject(new Error('Wake Gemma on this device first.'));
    return this.request('generate', messages);
  }
  stop(message = 'Gemma has gone to sleep.') {
    this.worker?.terminate(); this.worker = undefined; this.state = 'downloadable';
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
}
const gemma = new GemmaClient(() => new Worker(new URL('./gemma.worker.ts', import.meta.url), { type: 'module' }));
export async function browserSupport() {
  if (gemma.state === 'available' || gemma.state === 'downloading') return { text: gemma.state, vision: gemma.state };
  if (isHandheld()) return { text: 'unavailable' as const, vision: 'unavailable' as const };
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: { has: (feature: string) => boolean } } | null> } } | undefined)?.gpu;
  const adapter = globalThis.isSecureContext && gpu ? await gpu.requestAdapter().catch(() => null) : null;
  const state: Availability = adapter?.features.has('shader-f16') ? 'downloadable' : 'unavailable';
  return { text: state, vision: state };
}
export async function enableBrowserAI(onProgress: (progress: number) => void, cachedOnly = false, onPhase?: (value: GemmaPhase) => void) {
  if ((await browserSupport()).text === 'unavailable') throw new Error('Use a WebGPU-capable laptop browser, such as recent Chrome or Edge.');
  await gemma.load(onProgress, cachedOnly, onPhase);
}
export const browserCompletion = (messages: ChatInput[], _vision = false) => gemma.generate(messages);
export const sleepGemma = () => gemma.stop();
