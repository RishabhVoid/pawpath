import { embed } from '../server/brain.js';

const started = Date.now();
try {
  const vector = await embed('A yellow flower beside our favorite walking path.');
  console.info('Embedding model ready: ' + vector.length + ' dimensions in ' + (Date.now() - started) + ' ms. Cached in .cache/models for offline reuse.');
} catch { console.error('Could not warm the embedding model. Connect once to download its files, then retry.'); process.exitCode = 1; }
