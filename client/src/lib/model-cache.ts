export const gemmaModelId = 'onnx-community/gemma-4-E2B-it-ONNX';
export const gemmaRevision = '5f09dcfb04eddbc9d8e2ebd8a0bf5250d048c79e';
const cacheName = 'transformers-cache';
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'processor_config.json', 'preprocessor_config.json', ...['audio_encoder', 'decoder_model_merged', 'embed_tokens', 'vision_encoder'].flatMap(name => [`onnx/${name}_q4f16.onnx`, `onnx/${name}_q4f16.onnx_data`])];

async function modelEntries(storage: CacheStorage) {
  if (!(await storage.has(cacheName))) return null;
  const cache = await storage.open(cacheName);
  const entries = (await cache.keys()).filter(request => {
    const url = new URL(request.url);
    return url.origin === 'https://huggingface.co' && url.pathname.startsWith('/' + gemmaModelId + '/resolve/');
  });
  return { cache, entries };
}
export async function hasDownloadedModel(storage = globalThis.caches) {
  if (!storage) return false;
  return Boolean((await modelEntries(storage))?.entries.length);
}
export async function hasInstalledModel(storage = globalThis.caches) {
  if (!storage) return false;
  const found = await modelEntries(storage);
  const entries = new Set(found?.entries.map(request => request.url));
  const prefix = `https://huggingface.co/${gemmaModelId}/resolve/${gemmaRevision}/`;
  return modelFiles.every(file => entries.has(prefix + file));
}
export function cachedModelFetch(fetcher: typeof fetch, storage = globalThis.caches): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const prefix = '/' + gemmaModelId + '/resolve/';
    if (url.origin === 'https://huggingface.co' && url.pathname.startsWith(prefix)) {
      // Transformers checks tokenizer metadata at "main" even when loading a pinned revision.
      const file = url.pathname.slice(prefix.length).split('/').slice(1).join('/');
      const pinned = `https://huggingface.co${prefix}${gemmaRevision}/${file}`;
      if (storage && await storage.has(cacheName)) {
        const saved = await (await storage.open(cacheName)).match(pinned);
        if (saved) return saved;
      }
      return new Response(null, { status: 404 });
    }
    return fetcher(input, init);
  };
}
export async function deleteDownloadedModel(storage = globalThis.caches) {
  if (!storage) throw new Error('This browser cannot manage downloaded model files. Clear Pawpath’s site data in browser settings instead.');
  const found = await modelEntries(storage);
  if (found) {
    for (const request of found.entries) await found.cache.delete(request);
    if ((await modelEntries(storage))?.entries.length) throw new Error('Some model files could not be deleted. Please try again.');
  }
}
