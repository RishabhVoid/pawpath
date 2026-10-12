import { config } from './config.js';
import { connectStore } from './store.js';
import { createApp } from './app.js';

const store = await connectStore();
const server = createApp(store).listen(config.port, '0.0.0.0', () => console.info('Pawpath API listening on port ' + config.port + ' (' + store.kind + ')'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { void store.close().then(() => process.exit(0)); }); });
