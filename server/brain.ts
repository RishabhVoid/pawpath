import { config } from './config.js';
import { AppError } from './errors.js';
import type { ChatInput, VisionResult } from '../shared/types.js';
import { shortLine } from '../shared/pet.js';
import { readVision } from '../shared/vision.js';

let extractor: Promise<unknown> | undefined;
let embeddingQueue = Promise.resolve();
export async function embed(text: string): Promise<number[]> {
  extractor ||= import('@huggingface/transformers').then(({ pipeline, env }) => {
    env.cacheDir = '.cache/models';
    env.allowRemoteModels = process.env.PAWPATH_OFFLINE !== 'true';
    return pipeline('feature-extraction', config.embeddingModel, { dtype: 'q8' });
  }).catch(error => { extractor = undefined; throw error; });
  const run = await extractor as (text: string, options: object) => Promise<{ data: Float32Array }>;
  const result = embeddingQueue.then(() => run(text.slice(0, 1000), { pooling: 'mean', normalize: true }));
  embeddingQueue = result.then(() => undefined, () => undefined);
  const output = await result;
  const vector = Array.from(output.data);
  if (vector.length !== config.dimensions || vector.some(v => !Number.isFinite(v))) throw new AppError(503, 'embedding', 'The memory model is warming up. Please try again.');
  return vector;
}
export async function completion(messages: ChatInput[], mode: 'local', vision = false): Promise<string> {
  const started = Date.now();
  try {
    const response = await fetch(config.localUrl + '/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(vision ? 60_000 : 25_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.localModel, messages, max_tokens: vision ? 180 : 120, stream: false, reasoning_effort: 'none', ...(vision ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!response.ok) throw new AppError(response.status === 429 ? 429 : 502, 'brain_response', 'Gemma could not answer. Check the model and try again.');
    const data = await response.json() as { choices?: { message: { content: string } }[]; usage?: { total_tokens: number } };
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) throw new AppError(502, 'empty_response', 'Gemma returned an empty reply. Please try again.');
    console.info(JSON.stringify({ event: 'brain', mode, latencyMs: Date.now() - started, tokens: data.usage?.total_tokens ?? null, success: true }));
    return vision ? content : shortLine(content);
  } catch (error) {
    console.info(JSON.stringify({ event: 'brain', mode, latencyMs: Date.now() - started, success: false }));
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'brain_unreachable', 'Your laptop is not reachable. Start Ollama or use a supported browser.', 'laptop');
  }
}
export function parseVision(text: string): VisionResult {
  try { return readVision(text); }
  catch { throw new AppError(502, 'vision_format', 'Gemma could not read that discovery. Try a clearer outdoor photo.'); }
}
export async function ollamaHealthy() {
  try {
    const response = await fetch(config.localUrl + '/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = await response.json() as { models: { name: string }[] };
    return data.models.some(model => model.name === config.localModel || model.name === config.localModel + ':latest');
  } catch { return false; }
}
export async function localHealthy() { return !config.production && await ollamaHealthy(); }
