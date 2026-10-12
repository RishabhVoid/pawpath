import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import QRCode from 'qrcode';
import { config } from '../server/config.js';
import { createBridge } from '../server/bridge.js';

const args = process.argv.slice(2);
const option = (name: string) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const children: ChildProcess[] = [];
let server: Server | undefined;
let stopping = false;
function stop(code: number, message?: string) {
  if (stopping) return;
  stopping = true;
  if (message) console.error(message);
  children.forEach(child => { if (child.exitCode === null) child.kill(); });
  if (server?.listening) server.close(() => process.exit(code));
  else process.exit(code);
  setTimeout(() => process.exit(code), 3000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
async function command(binary: string, parameters: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, parameters, { stdio: 'inherit' }); children.push(child);
    child.once('error', () => reject(new Error('Install ' + binary + ' and make sure it is on your PATH.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(binary + ' exited before setup completed.')));
  });
}
async function tags() {
  const response = await fetch(config.localUrl + '/api/tags', { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Ollama is not ready.');
  return response.json() as Promise<{ models: { name: string }[] }>;
}
async function run() {
  const appUrl = new URL(option('app') || 'http://localhost:5173');
  const manualTunnel = option('tunnel');
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password) throw new Error('Provide the Pawpath app URL with --app=https://your-app.onrender.com.');
  if (!/^gemma4(?::|$)/.test(config.localModel)) throw new Error('The laptop helper only runs Gemma 4 models.');
  try { await tags(); } catch {
    console.info('Starting Ollama…');
    const ollama = spawn('ollama', ['serve'], { stdio: 'ignore' }); children.push(ollama);
    ollama.once('error', () => { console.error('Install Ollama before starting the helper.'); });
    let healthy = false;
    for (let attempt = 0; attempt < 12 && !healthy; attempt++) { await new Promise(resolve => setTimeout(resolve, 500)); try { await tags(); healthy = true; } catch {} }
    if (!healthy) throw new Error('Ollama did not start. Run ollama serve and try again.');
  }
  const installed = await tags();
  if (!installed.models.some(model => model.name === config.localModel || model.name === config.localModel + ':latest')) await command('ollama', ['pull', config.localModel]);
  const token = randomBytes(32).toString('base64url');
  const port = 4318;
  await new Promise<void>((resolve, reject) => {
    server = createBridge(token, appUrl.origin).listen(port, '127.0.0.1', () => resolve());
    server.once('error', () => reject(new Error('Port 4318 is unavailable. Stop the other laptop helper and retry.')));
  });
  async function showPairing(tunnel: string) {
    const url = new URL(tunnel);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The phone pairing tunnel must use HTTPS.');
    const pairing = Buffer.from(JSON.stringify({ url: url.origin, token, model: config.localModel })).toString('base64url');
    const link = appUrl.origin + '/#pair=' + pairing;
    await mkdir('.cache', { recursive: true });
    await writeFile('.cache/pairing.svg', await QRCode.toString(link, { type: 'svg', margin: 2 }), { mode: 0o600 });
    console.info(await QRCode.toString(link, { type: 'terminal', small: true }));
    console.info('Scan this QR in your phone browser, or paste this link in Pawpath settings:\n' + link);
    console.info('Pairing QR saved to .cache/pairing.svg. Keep the helper open; do not share the token publicly.');
    if (appUrl.hostname === 'localhost' || appUrl.hostname === '127.0.0.1') console.info('For phone testing, restart with --app=https://your-deployed-pawpath-url.');
  }
  if (manualTunnel) { await showPairing(manualTunnel); return; }
  console.info('Opening an HTTPS Cloudflare tunnel…');
  const tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] }); children.push(tunnel);
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The HTTPS tunnel did not become ready. Check your internet connection and retry.')), 60_000);
    let output = '', ready = false;
    tunnel.stderr?.on('data', chunk => {
      output = (output + chunk.toString()).slice(-4000);
      const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (url && !ready) { ready = true; clearTimeout(timer); resolve(url[0]); }
    });
    tunnel.once('error', () => { clearTimeout(timer); reject(new Error('Install cloudflared, or provide --tunnel=https://your-tunnel.example pointing to port 4318.')); });
    tunnel.once('exit', () => {
      clearTimeout(timer);
      if (!ready) reject(new Error('Tunnel stopped before pairing. Check cloudflared and retry.'));
      else stop(1, 'Your laptop tunnel disconnected. Restart the helper and pair again.');
    });
  });
  await showPairing(address);
}
void run().catch(error => stop(1, error instanceof Error ? error.message : 'Laptop setup failed.'));
