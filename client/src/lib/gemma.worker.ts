import { AutoProcessor, Gemma4ForConditionalGeneration, load_image, Tensor, env } from '@huggingface/transformers';
import type { ChatInput } from '../../../shared/types.js';
import { cachedModelFetch, gemmaModelId as modelId, gemmaRevision as revision } from './model-cache.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
const modelFetch = env.fetch;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
let model: Awaited<ReturnType<typeof Gemma4ForConditionalGeneration.from_pretrained>>;
let queue = Promise.resolve();
const scope = globalThis as typeof globalThis & { postMessage: (data: unknown) => void };

async function respond(data: { id: number; type: 'load' | 'generate'; messages: ChatInput[]; cachedOnly?: boolean }) {
  let stage = data.type === 'load' ? data.cachedOnly ? 'loading saved files' : 'downloading files' : 'answering';
  try {
    if (data.type === 'load') {
      env.fetch = data.cachedOnly ? cachedModelFetch((input, init) => modelFetch(input instanceof Request ? input.url : input, init)) : modelFetch;
      scope.postMessage({ id: data.id, type: 'phase', phase: data.cachedOnly ? 'loading' : 'downloading' });
      processor = await AutoProcessor.from_pretrained(modelId, { revision });
      stage = 'starting the model';
      model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, { revision, dtype: 'q4f16', device: 'webgpu', progress_callback: info => {
        if (info.status === 'progress_total') scope.postMessage({ id: data.id, type: 'progress', progress: info.progress / 100 });
      } });
      scope.postMessage({ id: data.id, type: 'phase', phase: 'warming' });
      stage = 'warming up';
      await generate([{ role: 'user', content: 'Say hello in one word.' }], 4);
      scope.postMessage({ id: data.id, type: 'ready' });
    } else {
      const text = await generate(data.messages, 160);
      if (!text.trim()) throw new Error('Gemma returned an empty reply. Please try again.');
      scope.postMessage({ id: data.id, type: 'result', text });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Gemma failed while ${stage}:`, error);
    scope.postMessage({ id: data.id, type: 'error', fatal: data.type === 'load', message: data.type === 'load' ? `Gemma stopped while ${stage}: ${detail}` : detail || 'Gemma could not answer.' });
  }
}
async function generate(messages: ChatInput[], maxTokens: number) {
  let imageUrl: string | undefined;
  const turns = messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.slice().sort((a, b) => Number(b.type === 'image_url') - Number(a.type === 'image_url')).map(part => {
    if (part.type === 'image_url') { imageUrl = part.image_url!.url; return { type: 'image' }; }
    return { type: 'text', text: part.text || '' };
  }) }));
  const templateOptions = { enable_thinking: false, add_generation_prompt: true };
  const prompt = processor.apply_chat_template(turns, templateOptions);
  const image = imageUrl ? await load_image(imageUrl) : null;
  const inputs = await processor(prompt, image, null, { add_special_tokens: false });
  const tokens = inputs.input_ids.dims.at(-1);
  let outputs: Tensor | undefined;
  try {
    if (tokens > 4096) throw new Error('This conversation is too long. Try a shorter question.');
    outputs = await model.generate({ ...inputs, max_new_tokens: maxTokens, do_sample: false }) as Tensor;
    const generated = outputs.slice(null, [tokens, null]);
    try { return processor.batch_decode(generated, { skip_special_tokens: true })[0]; }
    finally { generated.dispose(); }
  } finally { outputs?.dispose(); for (const value of Object.values(inputs)) if (value instanceof Tensor) value.dispose(); }
}
globalThis.addEventListener('message', (event: MessageEvent) => { queue = queue.then(() => respond(event.data)); });
