import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicAssets = ['sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'fonts/dm-sans-latin.woff2', 'fonts/dm-sans-latin-ext.woff2'];
publicAssets.push('art/pets-preview/simple-trail.webp', 'art/pets-preview/simple-wild.webp', 'art/pets-preview/contours.svg');

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  plugins: [react(), {
    name: 'pawpath-public-assets',
    async generateBundle() {
      for (const fileName of publicAssets) this.emitFile({ type: 'asset', fileName, source: await readFile(new URL('./public/' + fileName, import.meta.url)) });
    },
  }],
  build: { copyPublicDir: false },
  server: { proxy: { '/api': 'http://127.0.0.1:3001' }, watch: { ignored: ['**/*.[eE][nN][vV]*'] } },
});
