import { MongoClient, type Document } from 'mongodb';
import { config } from './config.js';
import { limitError } from './errors.js';

export type Row = Document & { _id: string };
export interface Store {
  kind: 'mongodb' | 'development';
  vectorReady: boolean;
  findOne(name: string, filter: Document): Promise<Row | null>;
  find(name: string, filter: Document, limit?: number): Promise<Row[]>;
  insert(name: string, row: Row): Promise<void>;
  update(name: string, filter: Document, update: Document, upsert?: boolean): Promise<Row | null>;
  remove(name: string, filter: Document): Promise<void>;
  reserve(key: string, cap: number, kind: string, expiresAt: Date): Promise<void>;
  vector(petId: string, embedding: number[]): Promise<Row[]>;
  indexes(): Promise<void>;
  close(): Promise<void>;
}

export class MongoStore implements Store {
  kind = 'mongodb' as const;
  vectorReady = false;
  constructor(public client: MongoClient) {}
  collection(name: string) { return this.client.db(config.mongoDb).collection<Row>(name); }
  async findOne(name: string, filter: Document) { return this.collection(name).findOne(filter); }
  async find(name: string, filter: Document, limit = 100) { return this.collection(name).find(filter).sort({ createdAt: -1 }).limit(limit).toArray(); }
  async insert(name: string, row: Row) { await this.collection(name).insertOne(row); }
  async update(name: string, filter: Document, update: Document, upsert = false) { return this.collection(name).findOneAndUpdate(filter, update, { upsert, returnDocument: 'after' }); }
  async remove(name: string, filter: Document) { await this.collection(name).deleteMany(filter); }
  async reserve(key: string, cap: number, kind: string, expiresAt: Date) {
    try {
      const row = await this.update('usageCounters', { _id: key, count: { $lt: cap } }, { $inc: { count: 1 }, $setOnInsert: { expiresAt, owner: key.startsWith('memory:') ? key.split(':')[1] : key.split(':')[0] } }, true);
      if (!row) throw limitError(kind);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw limitError(kind);
      throw error;
    }
  }
  async vector(petId: string, embedding: number[]) {
    const rows = await this.collection('memories').aggregate<Row>([
      { $vectorSearch: { index: config.vectorIndex, path: 'embedding', queryVector: embedding, numCandidates: 60, limit: 3, filter: { petId } } },
      { $project: { text: 1, category: 1, petId: 1, createdAt: 1, geoCell: 1, score: { $meta: 'vectorSearchScore' } } },
    ]).toArray();
    this.vectorReady = true;
    return rows.filter(row => row.score >= 0.65);
  }
  async indexes() {
    await Promise.all([
      this.collection('users').createIndex({ tokenHash: 1 }, { unique: true }),
      this.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('handoffs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('users').createIndex({ friendCode: 1 }, { unique: true }),
      this.collection('pets').createIndex({ userId: 1 }, { unique: true }),
      this.collection('walks').createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { endedAt: null } }),
      this.collection('memories').createIndex({ petId: 1, createdAt: -1 }),
      this.collection('memoryPhotos').createIndex({ petId: 1 }),
      this.collection('friendships').createIndex({ users: 1 }),
      this.collection('usageCounters').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('placesCache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
    try {
      const existing = await this.collection('memories').listSearchIndexes(config.vectorIndex).toArray();
      if (!existing.length) await this.collection('memories').createSearchIndex({ name: config.vectorIndex, type: 'vectorSearch', definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: config.dimensions, similarity: 'cosine' }, { type: 'filter', path: 'petId' }] } });
      this.vectorReady = existing.some(index => (index as Document).queryable === true);
    } catch {
      console.info('Vector index unavailable. Local MongoDB uses explicitly labelled local similarity search; Atlas needs a ready vector index.');
    }
  }
  async close() { await this.client.close(); }
}

function matches(row: Row, filter: Document): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return (value as Document[]).some(f => matches(row, f));
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, v]) => op === '$lt' ? actual < (v as number) : op === '$gte' ? actual >= (v as number) : op === '$exists' ? (actual !== undefined) === v : op === '$ne' ? Array.isArray(actual) ? !actual.includes(v) : actual !== v : op === '$in' ? (v as unknown[]).includes(actual) : false);
    }
    return Array.isArray(actual) ? actual.includes(value) : actual === value;
  });
}
export class DevelopmentStore implements Store {
  kind = 'development' as const;
  vectorReady = false;
  data = new Map<string, Row[]>();
  rows(name: string) { if (!this.data.has(name)) this.data.set(name, []); return this.data.get(name)!; }
  async findOne(name: string, filter: Document) { return this.rows(name).find(row => matches(row, filter)) || null; }
  async find(name: string, filter: Document, limit = 100) { return this.rows(name).filter(row => matches(row, filter)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit); }
  async insert(name: string, row: Row) {
    if (this.rows(name).some(r => r._id === row._id || (name === 'walks' && r.userId === row.userId && r.endedAt === null && row.endedAt === null))) throw Object.assign(new Error('Duplicate key'), { code: 11000 });
    this.rows(name).push(structuredClone(row));
  }
  async update(name: string, filter: Document, update: Document, upsert = false) {
    let row = this.rows(name).find(r => matches(r, filter));
    const inserted = !row;
    if (!row && !upsert) return null;
    if (!row) { row = { _id: filter._id }; this.rows(name).push(row); }
    Object.assign(row, inserted ? update.$setOnInsert || {} : {}, update.$set || {});
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + (v as number);
    for (const [k, v] of Object.entries(update.$addToSet || {})) { row[k] ||= []; if (!row[k].includes(v)) row[k].push(v); }
    return structuredClone(row);
  }
  async remove(name: string, filter: Document) { this.data.set(name, this.rows(name).filter(row => !matches(row, filter))); }
  async reserve(key: string, cap: number, kind: string, expiresAt: Date) {
    const row = this.rows('usageCounters').find(r => r._id === key);
    if ((row?.count || 0) >= cap) throw limitError(kind);
    await this.update('usageCounters', { _id: key }, { $inc: { count: 1 }, $setOnInsert: { expiresAt, owner: key.startsWith('memory:') ? key.split(':')[1] : key.split(':')[0] } }, true);
  }
  async vector(petId: string, embedding: number[]) { return localSimilarity(await this.find('memories', { petId }, 500), embedding); }
  async indexes() {}
  async close() {}
}
export function localSimilarity(rows: Row[], embedding: number[]) {
  return rows.map(row => ({ ...row, score: (row.embedding as number[]).reduce((sum, v, i) => sum + v * embedding[i], 0) })).filter(row => row.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, 3);
}
export async function connectStore(): Promise<Store> {
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 2500 });
  try { await client.connect(); const store = new MongoStore(client); await store.indexes(); return store; }
  catch (error) { await client.close(); if (config.production) throw new Error('MongoDB connection failed; check the configured connection and network access.'); console.info('MongoDB not reachable: temporary development storage enabled. Start MongoDB for persistence.'); return new DevelopmentStore(); }
}
