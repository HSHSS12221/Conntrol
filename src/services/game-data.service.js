'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const STATIC_ROOT = path.resolve(__dirname, '../../data/static');
const MAX_SEED_FILES = 1000;
const STATIC_CACHE_TTL_MS = 30_000;
const staticCache = new Map();
const staticReadsInFlight = new Map();

function normalizeStaticPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('static/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid static data path');
  }
  if (!normalized.toLowerCase().endsWith('.json')) throw new Error('Only JSON static data can be read');
  return normalized;
}

async function collectJsonFiles(folder = STATIC_ROOT, prefix = '') {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(folder, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectJsonFiles(absolute, relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(relative);
    if (files.length > MAX_SEED_FILES) throw new Error(`Static data exceeds ${MAX_SEED_FILES} JSON files`);
  }
  return files;
}

function createGameDataService(supabase) {
  if (!supabase) throw new Error('Supabase client is required');

  return {
    async list() {
      const { data, error } = await supabase.from('game_static_data').select('file_path,sha256,updated_at').order('file_path');
      if (error) throw error;
      return data;
    },

    async get(filePath) {
      const key = normalizeStaticPath(filePath);
      const cached = staticCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value);
      if (staticReadsInFlight.has(key)) return structuredClone(await staticReadsInFlight.get(key));

      const read = (async () => {
        const { data, error } = await supabase.from('game_static_data').select('data,updated_at').eq('file_path', key).maybeSingle();
        if (error) throw error;
        const value = data ? { path: key, updated_at: data.updated_at, data: data.data } : null;
        if (value) staticCache.set(key, { value: structuredClone(value), expiresAt: Date.now() + STATIC_CACHE_TTL_MS });
        else staticCache.delete(key);
        return value;
      })();
      staticReadsInFlight.set(key, read);
      try { return structuredClone(await read); }
      finally { staticReadsInFlight.delete(key); }
    },

    async syncFromRepository() {
      const files = (await collectJsonFiles()).sort();
      if (!files.length) return { synced: 0, files: [] };
      const rows = [];
      for (const relative of files) {
        const filePath = `static/${relative}`;
        const absolute = path.resolve(STATIC_ROOT, relative);
        if (!absolute.startsWith(`${STATIC_ROOT}${path.sep}`)) throw new Error('Static path escaped data directory');
        const text = await fs.readFile(absolute, 'utf8');
        const parsed = JSON.parse(text);
        rows.push({ file_path: filePath, data: parsed, sha256: crypto.createHash('sha256').update(text).digest('hex'), updated_at: new Date().toISOString() });
      }
      let synced = 0;
      for (let offset = 0; offset < rows.length; offset += 5) {
        const { data, error } = await supabase.from('game_static_data').upsert(rows.slice(offset, offset + 5), { onConflict: 'file_path' }).select('file_path');
        if (error) throw error;
        synced += data.length;
      }
      staticCache.clear();
      return { synced, files };
    }
  };
}

module.exports = { createGameDataService, normalizeStaticPath };
