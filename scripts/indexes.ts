import { MongoClient } from 'mongodb';
import { config } from '../server/config.js';
import { MongoStore } from '../server/store.js';

const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
try { await client.connect(); const store = new MongoStore(client); await store.indexes(); console.info('Database indexes checked. Vector readiness: ' + store.vectorReady); }
catch { console.error('Could not create indexes. Check MongoDB access and vector-search support.'); process.exitCode = 1; }
finally { await client.close(); }
