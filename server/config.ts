import { isIP } from 'node:net';

export function resolveOllamaUrl(values: { OLLAMA_URL?: string; IP?: string; NODE_ENV?: string }) {
  if (values.OLLAMA_URL) return values.OLLAMA_URL.replace(/\/+$/, '');
  const ip = values.IP?.trim();
  if (values.NODE_ENV !== 'production' && ip) {
    const version = isIP(ip);
    if (!version) throw new Error('IP must be a laptop IP address. For a full Ollama URL, set OLLAMA_URL instead.');
    return 'http://' + (version === 6 ? '[' + ip + ']' : ip) + ':11434';
  }
  return 'http://127.0.0.1:11434';
}

export const config = {
  production: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 3001),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DATABASE || 'pawpath',
  geoapifyKey: process.env.GEOAPIFY_API_KEY || '',
  localModel: process.env.GEMMA_LOCAL_MODEL || 'gemma4:e4b',
  localUrl: resolveOllamaUrl(process.env),
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  vectorIndex: 'pet_memories',
  dimensions: 384,
};
