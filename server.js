require('module-alias/register');
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const authTemplate = require('./templates/auth.json');
const { createClient } = require('@supabase/supabase-js');
const { createGameDataService } = require('./src/services/game-data.service');
const { createWhitelistRepository } = require('./src/repositories/whitelist.repository');
const playerDataService = require('./src/services/player-data.service');
const inventoryService = require('./src/services/inventory.service');
const PlayerModel = require('./src/models/player.model');
const ServerInfoModel = require('./src/models/server.model');
const staticJsonUtil = require('./src/utils/static-json.util');
const gameHealthRoutes = require('./src/Health');

const app = express();
app.set('trust proxy', 1);
// Some game/proxy clients append the JSON content type twice. Express will
// otherwise treat `application/json, application/json` as an unknown media
// type and leave req.body empty, which prevents Steam auth and game saves.
app.use((req, _res, next) => {
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string' && contentType.includes(',')) {
    const values = contentType.split(',').map(value => value.split(';', 1)[0].trim().toLowerCase());
    if (values.length > 1 && values.every(value => value === 'application/json')) {
      req.headers['content-type'] = 'application/json';
    }
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const adminLogs = [];
function recordAdminLog(level, source, message, status = null, game = null) {
  if (!game && /^(Game API|Game Client|Steam Auth|Game Error|Match Log|Matchmaking|Player Save)$/.test(source)) {
    game = { name: 'Home Sweet Home Online', client: 'server-side event' };
  }
  adminLogs.unshift({ at: new Date().toISOString(), level, source, message: String(message).slice(0, 1200), status, game });
  if (adminLogs.length > 300) adminLogs.length = 300;
}
app.use((req, res, next) => {
  const requestPath = req.path;
  if (!/^\/(?:live|logapi)\//i.test(requestPath)) return next();
  const logPath = sanitizeGamePath(requestPath);
  const startedAt = Date.now();
  const isLiveRequest = /^\/live\//i.test(requestPath);
  const isGameRequest = isLiveRequest || /^\/logapi\//i.test(requestPath);
  const game = isGameRequest ? identifyGameClient(req) : null;
  // Record shape and field names only. Never record payload values: game auth
  // requests may contain Steam tickets, JWTs, account IDs, or session secrets.
  const requestShape = isGameRequest ? describeGamePayloadShape(req.body) : [];
  const queryFields = isGameRequest ? [...new Set(Object.keys(req.query || {}))].slice(0, 20) : [];
  let responseShape = [];
  if (isGameRequest) {
    const sendJson = res.json.bind(res);
    res.json = payload => {
      responseShape = describeGamePayloadShape(payload);
      return sendJson(payload);
    };
    console.info(`[HSHO] <- ${req.method} ${logPath}; client=${game.client}; content-type=${String(req.get('content-type') || 'missing').slice(0, 80)}; request=${requestShape.join(',') || '(empty)'}; query=${queryFields.join(',') || '(none)'}`);
  }
  res.once('finish', () => {
    const elapsed = Date.now() - startedAt;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    const responseType = String(res.getHeader('content-type') || 'unknown').split(';', 1)[0];
    const diagnosis = diagnoseGameHttpResult(res.statusCode, responseShape);
    const summary = `${req.method} ${logPath} -> HTTP ${res.statusCode} (${elapsed}ms); request=${requestShape.join(',') || '(empty)'}; response=${responseShape.join(',') || '(shape unavailable)'}; response-type=${responseType}; query=${queryFields.join(',') || '(none)'}${diagnosis ? `; diagnosis=${diagnosis}` : ''}`;
    recordAdminLog(level, isLiveRequest ? 'Game API' : 'Game Client', summary, res.statusCode, game);
    if (isGameRequest) console.info(`[HSHO] -> ${req.method} ${logPath}; HTTP ${res.statusCode}; response=${responseShape.join(',') || '(shape unavailable)'}; ${elapsed}ms`);
  });
  next();
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_ANON_KEY, ADMIN_TOKEN, LAUNCHER_TOKEN } = process.env;
function publicBaseUrl(req) { return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, ''); }
function publishedServerInfoUrl(req, base = publicBaseUrl(req)) { return `${base}/public/servers`; }
function normalizeHostUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new Error('Host ต้องเป็น URL ต้นทาง เช่น https://example.onrender.com โดยไม่มี path');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Host ที่เผยแพร่ต้องใช้ HTTPS');
  return parsed.origin;
}
async function launcherBaseUrl(req) {
  if (supabase) {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'launcher_host_url').maybeSingle();
    if (error && error.code !== 'PGRST205' && error.code !== '42P01') throw error;
    const saved = typeof data?.value === 'string' ? data.value : data?.value?.url;
    if (saved) return normalizeHostUrl(saved);
  }
  return normalizeHostUrl(publicBaseUrl(req));
}
// Prefer Supabase's current server-only secret key; keep the legacy variable for existing deployments.
const supabaseServerKey = SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && supabaseServerKey
  ? createClient(SUPABASE_URL, supabaseServerKey, { auth: { persistSession: false } }) : null;
const gameDataService = supabase ? createGameDataService(supabase) : null;
const whitelistRepository = supabase ? createWhitelistRepository(supabase) : null;
if (supabase) { PlayerModel.configure(supabase); ServerInfoModel.configure(supabase); staticJsonUtil.configure(supabase); gameHealthRoutes.configure(supabase); }
const db = {
  collection(table) {
    return {
      async find(filters = {}, { limit = 500, orderBy = 'created_at', ascending = false } = {}) {
        let q = supabase.from(table).select('*').limit(limit).order(orderBy, { ascending });
        for (const [key, value] of Object.entries(filters)) q = value === null ? q.is(key, null) : q.eq(key, value);
        const { data, error } = await q; if (error) throw error; return data;
      },
      async insertOne(document) { const { data, error } = await supabase.from(table).insert(document).select().single(); if (error) throw error; return data; },
      async updateOne(id, changes) { const { data, error } = await supabase.from(table).update(changes).eq('id', id).select().single(); if (error) throw error; return data; },
      async deleteOne(id) { const { error } = await supabase.from(table).delete().eq('id', id); if (error) throw error; return { deleted: !error }; }
    };
  }
};
app.use('/api', (req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.' });
  // Player-facing room routes authenticate with Supabase Auth access tokens,
  // not the admin dashboard token.
  if (/^\/lobbies(?:\/|$)/i.test(req.path)) return next();
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Set ADMIN_TOKEN on the server.' });
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
// Application-owned lobby API. This is separate from the admin API and uses
// each caller's Supabase Auth identity for membership and room ownership.
app.use('/api/lobbies', async (req, res, next) => {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ ok: false, error: 'A Supabase access token is required.' });
    const { data, error } = await supabase.auth.getUser(match[1]);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: 'The access token is invalid or expired.' });
    req.roomUser = data.user;
    next();
  } catch (error) { next(error); }
});
app.post('/api/lobbies', async (req, res) => {
  try {
    const name = cleanRoomText(req.body?.name, 48);
    const gameMode = cleanRoomText(req.body?.gameMode || 'default', 32);
    const region = cleanRoomText(req.body?.region || 'auto', 24);
    const displayName = cleanRoomText(req.body?.displayName || req.roomUser.user_metadata?.display_name || 'Player', 32);
    const maxPlayers = Number(req.body?.maxPlayers ?? 5);
    if (!name) return res.status(400).json({ ok: false, error: 'Room name is required.' });
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 16)
      return res.status(400).json({ ok: false, error: 'maxPlayers must be an integer from 2 to 16.' });
    const { data, error } = await supabase.rpc('room_create', {
      p_user_id: req.roomUser.id, p_name: name, p_game_mode: gameMode,
      p_region: region, p_max_players: maxPlayers, p_display_name: displayName,
    });
    if (error) return sendRoomError(res, error);
    res.status(201).json({ ok: true, data });
  } catch (error) { sendRoomError(res, error); }
});
app.get('/api/lobbies', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('room_search', {
      p_user_id: req.roomUser.id,
      p_game_mode: cleanRoomText(req.query.gameMode, 32) || null,
      p_region: cleanRoomText(req.query.region, 24) || null,
    });
    if (error) return sendRoomError(res, error);
    res.set('Cache-Control', 'no-store').json({ ok: true, data });
  } catch (error) { sendRoomError(res, error); }
});
app.post('/api/lobbies/:lobbyKey/join', async (req, res) => {
  try {
    const displayName = cleanRoomText(req.body?.displayName || req.roomUser.user_metadata?.display_name || 'Player', 32);
    const { data, error } = await supabase.rpc('room_join', {
      p_user_id: req.roomUser.id,
      p_lobby_key: cleanRoomText(req.params.lobbyKey, 64),
      p_display_name: displayName,
    });
    if (error) return sendRoomError(res, error);
    res.json({ ok: true, data });
  } catch (error) { sendRoomError(res, error); }
});
app.post('/api/lobbies/:lobbyKey/leave', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('room_leave', {
      p_user_id: req.roomUser.id,
      p_lobby_key: cleanRoomText(req.params.lobbyKey, 64),
    });
    if (error) return sendRoomError(res, error);
    res.json({ ok: true, data });
  } catch (error) { sendRoomError(res, error); }
});
app.get('/api/logs', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  res.set('Cache-Control', 'no-store').json(adminLogs.slice(0, limit));
});
app.post('/public/launcher/session', (req, res) => {
  if (!LAUNCHER_TOKEN) return res.status(503).json({ error: 'Launcher sessions are not configured' });
  const clientId = String(req.body.client_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return res.status(400).json({ error: 'A valid client_id is required' });
  res.set('Cache-Control', 'no-store').json({ client_id: clientId, client_token: signLauncherClient(clientId) });
});
app.get('/launcher/commands', async (req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  const clientId = String(req.query.client_id || '').trim();
  if (!clientId || clientId.length > 100) return res.status(400).json({ error: 'client_id is required' });
  if (!verifyLauncherClient(clientId, req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
  try { const { data, error } = await supabase.rpc('get_pending_launcher_commands', { p_client_id: clientId }); if (error) throw error; res.set('Cache-Control', 'no-store').json(data); } catch (e) { next(e); }
});
app.post('/launcher/commands/:id/ack', async (req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  const clientId = String(req.body.client_id || '').trim();
  if (!clientId || clientId.length > 100) return res.status(400).json({ error: 'client_id is required' });
  if (!verifyLauncherClient(clientId, req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
  try { const { error } = await supabase.from('launcher_command_deliveries').upsert({ command_id: req.params.id, client_id: clientId }, { onConflict: 'command_id,client_id' }); if (error) throw error; res.json({ received: true }); } catch (e) { next(e); }
});
// Launcher data export. Treat game data in this response as visible to launcher users; credentials stay private.
app.get('/launcher/bootstrap', async (req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  const clientId = String(req.query.client_id || '').trim();
  if (!clientId || clientId.length > 100) return res.status(400).json({ error: 'client_id is required' });
  if (!verifyLauncherClient(clientId, req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const serverInfoCollectionId = await coreCollectionId('serverinfo');
    const [serverRows, playerRows] = await Promise.all([
      fetchAllRows(() => supabase.from('admin_documents').select('data').eq('collection_id', serverInfoCollectionId).order('created_at')),
      fetchAllRows(() => supabase.from('whitelists').select('*').order('created_at'))
    ]);
    const base = await launcherBaseUrl(req);
    const players = playerRows.map(({ auth, session_token, notes, ...player }) => player);
    res.set('Cache-Control', 'no-store').json({
      updated_at: new Date().toISOString(),
      host: base,
      urls: { serverinfo: publishedServerInfoUrl(req, base), whitelist: `${base}/public/whitelist` },
      serverinfo: serverRows.map(row => row.data),
      players
    });
  } catch (e) { next(e); }
});
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/settings/launcher-host', async (req, res, next) => {
  try { res.json({ host: await launcherBaseUrl(req) }); } catch (e) { next(e); }
});
app.put('/api/settings/launcher-host', async (req, res, next) => {
  try {
    const host = normalizeHostUrl(req.body.host);
    const { error } = await supabase.from('app_settings').upsert({ key: 'launcher_host_url', value: { url: host }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    recordAdminLog('info', 'Launcher Config', `Launcher Host updated to ${host}`, 200);
    res.set('Cache-Control', 'no-store').json({ host });
  } catch (e) { if (e instanceof TypeError || e instanceof Error && /Host/.test(e.message)) return res.status(400).json({ error: e.message || 'Invalid Host URL' }); next(e); }
});
app.get('/api/launcher-update', async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('app_settings').select('value,updated_at').eq('key', 'launcher_update_manifest').maybeSingle();
    if (error) throw error;
    res.set('Cache-Control', 'no-store').json({ available: Boolean(data?.value?.version), version: data?.value?.version || null, notes: data?.value?.notes || '', updated_at: data?.updated_at || null });
  } catch (e) { next(e); }
});
app.put('/api/launcher-update', express.raw({ type: 'application/zip', limit: '100mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length < 4 || req.body[0] !== 0x50 || req.body[1] !== 0x4b) return res.status(400).json({ error: 'กรุณาเลือกไฟล์ ZIP ของ Launcher' });
    const version = String(req.query.version || '').trim();
    const notes = String(req.query.notes || '').trim().slice(0, 2000);
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return res.status(400).json({ error: 'Version ต้องเป็นรูปแบบเช่น 1.2.3' });
    const { data: currentRow, error: currentError } = await supabase.from('app_settings').select('value').eq('key', 'launcher_update_manifest').maybeSingle();
    if (currentError) throw currentError;
    if (currentRow?.value?.version && compareLauncherVersions(version, currentRow.value.version) <= 0) return res.status(400).json({ error: `Version ใหม่ต้องมากกว่า ${currentRow.value.version}` });
    const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
    const objectPath = `releases/${version}.zip`;
    const { error: uploadError } = await supabase.storage.from('launcher-updates').upload(objectPath, req.body, { contentType: 'application/zip', upsert: true, cacheControl: '0' });
    if (uploadError) throw uploadError;
    const manifest = { version, object_path: objectPath, sha256, notes, published_at: new Date().toISOString() };
    const { error: saveError } = await supabase.from('app_settings').upsert({ key: 'launcher_update_manifest', value: manifest, updated_at: manifest.published_at }, { onConflict: 'key' });
    if (saveError) throw saveError;
    recordAdminLog('info', 'Launcher Update', `Published Launcher ${version} (${req.body.length} bytes, SHA-256 ${sha256})`, 200);
    res.status(201).json({ version, sha256, bytes: req.body.length });
  } catch (e) { recordAdminLog('error', 'Launcher Update', e.message, 500); next(e); }
});
// Public game-download files are uploaded directly from the browser to Storage
// with a short-lived, path-scoped TUS token; large binaries never pass through Render.
const GAME_DOWNLOAD_BUCKET = 'game-downloads';
const GAME_DOWNLOAD_MAX_BYTES = Math.max(1, Number(process.env.GAME_DOWNLOAD_MAX_BYTES) || 40 * 1024 ** 3);
async function ensureGameDownloadBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  const bucket = (buckets || []).find(item => item.name === GAME_DOWNLOAD_BUCKET);
  if (!bucket) {
    const { error: createError } = await supabase.storage.createBucket(GAME_DOWNLOAD_BUCKET, { public: true });
    if (createError) throw createError;
  } else if (!bucket.public) {
    const { error: updateError } = await supabase.storage.updateBucket(GAME_DOWNLOAD_BUCKET, { public: true });
    if (updateError) throw updateError;
  }
}
function safeGameDownloadName(value) {
  const base = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  return base.normalize('NFKC').replace(/[^\w\-.() \u0E00-\u0E7F]/g, '_').replace(/\s+/g, '_').slice(0, 140) || 'game-download.zip';
}
function gameDownloadPublicUrl(objectPath) {
  const { data } = supabase.storage.from(GAME_DOWNLOAD_BUCKET).getPublicUrl(objectPath, { download: true });
  return data.publicUrl;
}
app.get('/api/mods', async (_req, res, next) => {
  try {
    await ensureGameDownloadBucket();
    const rows = [];
    for (const target of ['Binaries', 'Config', 'Content']) {
      for (let offset = 0; offset < 2000; offset += 100) {
        const { data, error } = await supabase.storage.from(GAME_DOWNLOAD_BUCKET).list(target, { limit: 100, offset, sortBy: { column: 'created_at', order: 'desc' } });
        if (error) throw error;
        rows.push(...data.filter(item => item.name && !item.id?.endsWith('/')).map(item => ({ ...item, target })));
        if (data.length < 100) break;
      }
    }
    const files = rows.map(item => {
      const objectPath = `${item.target}/${item.name}`;
      const splitAt = item.name.indexOf('__');
      return { path: objectPath, target: item.target, name: splitAt >= 0 ? item.name.slice(splitAt + 2) : item.name, size: Number(item.metadata?.size) || 0, created_at: item.created_at || null, url: gameDownloadPublicUrl(objectPath) };
    });
    res.set('Cache-Control', 'no-store').json({ files, max_file_bytes: GAME_DOWNLOAD_MAX_BYTES, used_bytes: files.reduce((sum, file) => sum + file.size, 0) });
  } catch (error) { next(error); }
});
// Launcher-facing manifest: each archive is installed into the selected game-root folder.
app.get('/public/mods', async (_req, res, next) => {
  try {
    await ensureGameDownloadBucket();
    const rows = [];
    for (const target of ['Binaries', 'Config', 'Content']) {
      const { data, error } = await supabase.storage.from(GAME_DOWNLOAD_BUCKET).list(target, { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });
      if (error) throw error;
      for (const item of data || []) if (item.name && !item.id?.endsWith('/')) {
        const path = `${target}/${item.name}`;
        const splitAt = item.name.indexOf('__');
        rows.push({ id: item.name.slice(0, splitAt), name: splitAt >= 0 ? item.name.slice(splitAt + 2) : item.name, install_into: target, size: Number(item.metadata?.size) || 0, url: gameDownloadPublicUrl(path), created_at: item.created_at || null, updated_at: item.updated_at || item.created_at || null });
      }
    }
    res.set('Cache-Control', 'no-store').json({ version: 1, mods: rows });
  } catch (error) { next(error); }
});
app.post('/api/mods/upload', async (req, res, next) => {
  try {
    if (!SUPABASE_ANON_KEY) return res.status(503).json({ error: 'ตั้งค่า SUPABASE_ANON_KEY ใน Render Environment ก่อนอัปโหลด (ใช้ publishable/anon key ห้ามใช้ service-role key)' });
    const target = String(req.body?.target || '');
    if (!['Binaries', 'Config', 'Content'].includes(target)) return res.status(400).json({ error: 'ปลายทางต้องเป็น Binaries, Config หรือ Content' });
    const name = safeGameDownloadName(req.body?.name);
    if (!name.toLowerCase().endsWith('.zip')) return res.status(400).json({ error: 'แพ็กเกจมอดต้องเป็นไฟล์ .zip' });
    const size = Number(req.body?.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > GAME_DOWNLOAD_MAX_BYTES) return res.status(400).json({ error: `ไฟล์ต้องมีขนาดไม่เกิน ${(GAME_DOWNLOAD_MAX_BYTES / 1024 ** 3).toFixed(1)} GB` });
    await ensureGameDownloadBucket();
    const objectPath = `${target}/${crypto.randomUUID()}__${name}`;
    const { data, error } = await supabase.storage.from(GAME_DOWNLOAD_BUCKET).createSignedUploadUrl(objectPath, { upsert: false });
    if (error) throw error;
    const supabaseUrl = new URL(SUPABASE_URL);
    const storageOrigin = supabaseUrl.hostname.endsWith('.supabase.co')
      ? `https://${supabaseUrl.hostname.replace(/\.supabase\.co$/i, '.storage.supabase.co')}`
      : supabaseUrl.origin;
    // TUS signed uploads use the dedicated `/sign` endpoint. The anon/publishable
    // key is safe to send to the browser; never return the service-role key here.
    res.status(201).json({ path: objectPath, target, token: data.token, bucket: GAME_DOWNLOAD_BUCKET, storage_origin: storageOrigin, apikey: SUPABASE_ANON_KEY || null, max_file_bytes: GAME_DOWNLOAD_MAX_BYTES });
  } catch (error) { next(error); }
});
app.delete('/api/mods', async (req, res, next) => {
  try {
    const objectPath = String(req.body?.path || '');
    if (!/^(?:Binaries|Config|Content)\/[0-9a-f-]{36}__[\w\-.() \u0E00-\u0E7F]{1,140}\.zip$/i.test(objectPath)) return res.status(400).json({ error: 'Invalid mod package path' });
    const { error } = await supabase.storage.from(GAME_DOWNLOAD_BUCKET).remove([objectPath]);
    if (error) throw error;
    recordAdminLog('info', 'Mods', `Deleted ${objectPath.slice(0, 170)}`, 200);
    res.json({ deleted: true });
  } catch (error) { next(error); }
});
app.get('/api/game-data', async (_req, res, next) => { try { res.set('Cache-Control', 'no-store').json(await gameDataService.list()); } catch (e) { next(e); } });
app.get('/api/game-data/file', async (req, res) => { try { const item = await gameDataService.get(req.query.path); if (!item) return res.status(404).json({ error: 'Game data file has not been synced to Supabase' }); res.set('Cache-Control', 'no-store').json(item); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/game-data/sync', async (_req, res, next) => { try { const result = await gameDataService.syncFromRepository(); recordAdminLog('info', 'Game Data', `Synced ${result.synced} JSON files to Supabase`, 200); res.json(result); } catch (e) { recordAdminLog('error', 'Game Data', e.message, 500); next(e); } });
// Admin player-save tools. Game credentials and session tokens are deliberately excluded.
app.get('/api/player-saves', async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('whitelists').select(PLAYER_SAVE_SELECT).order('updated_at', { ascending: false }).limit(5000);
    if (error) throw error;
    res.set('Cache-Control', 'no-store').json(data.map(row => ({ ...row, save_data: playerSaveDocument(row) })));
  } catch (e) { next(e); }
});
app.post('/api/player-saves', async (req, res, next) => {
  try {
    const steamId = String(req.body.steam_id || '').trim();
    if (!/^\d{17}$/.test(steamId)) return res.status(400).json({ error: 'Steam ID ต้องเป็น SteamID64 17 หลัก' });
    const { data: existing, error: lookupError } = await supabase.from('whitelists').select('id').eq('steam_id', steamId).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return res.status(409).json({ error: 'มี Save Data ของ Steam ID นี้แล้ว' });
    const template = await playerDataService.loadPlayerTemplate();
    const saveData = req.body.save_data === undefined ? template : req.body.save_data;
    const split = splitPlayerSave(saveData);
    const { data, error } = await supabase.from('whitelists').insert({
      steam_id: steamId, player_name: String(req.body.player_name || saveData.profile?.displayName || '').trim() || null,
      discord_id: null, status: 'pending', notes: null, auth: [], session_token: null,
      ...split, updated_at: new Date().toISOString()
    }).select(PLAYER_SAVE_SELECT).single();
    if (error) throw error;
    recordAdminLog('info', 'Player Save', `Created save data for SteamID ${steamId}`, 201);
    res.status(201).json({ ...data, save_data: playerSaveDocument(data) });
  } catch (e) { next(e); }
});
app.put('/api/player-saves/:id', async (req, res, next) => {
  try {
    const split = splitPlayerSave(req.body.save_data);
    const { data, error } = await supabase.from('whitelists').update({ ...split, updated_at: new Date().toISOString() }).eq('id', req.params.id).select(PLAYER_SAVE_SELECT).single();
    if (error) throw error;
    recordAdminLog('info', 'Player Save', `Saved game data for SteamID ${data.steam_id}`, 200);
    res.set('Cache-Control', 'no-store').json({ ...data, save_data: playerSaveDocument(data) });
  } catch (e) { if (e.message === 'Save Data ต้องเป็น JSON object' || e.message === 'Save Data ใหญ่เกิน 900 KB') return res.status(400).json({ error: e.message }); next(e); }
});
app.get('/api/whitelists', async (req, res, next) => { try { res.json(await db.collection('whitelists').find({}, { orderBy: 'updated_at' })); } catch (e) { next(e); } });
app.post('/api/whitelists', async (req, res, next) => { try { res.status(201).json(await db.collection('whitelists').insertOne(cleanWhitelist(req.body))); } catch (e) { next(e); } });
app.patch('/api/whitelists/:id', async (req, res, next) => { try {
  const changes = {}; const keys = ['steam_id','discord_id','player_name','status','notes','auth','session_token','profile','coin','amethyst','amulet','character_slot','role','ban_status','player_record','sticker_slot','inventory','immortal_data','game_data','is_online','last_online'];
  for (const key of keys) if (Object.hasOwn(req.body, key)) changes[key] = req.body[key];
  if (Object.hasOwn(changes,'steam_id')) changes.steam_id = String(changes.steam_id || '').trim();
  for (const key of ['discord_id','player_name','notes','session_token','role']) if (Object.hasOwn(changes,key)) changes[key] = String(changes[key] || '').trim() || null;
  for (const key of ['coin','amethyst','amulet']) if (Object.hasOwn(changes,key)) changes[key] = Number(changes[key]) || 0;
  if (Object.hasOwn(changes,'is_online')) changes.is_online = changes.is_online === true || changes.is_online === 'true';
  if (Object.hasOwn(changes,'status') && !['approved','pending','banned'].includes(changes.status)) return res.status(400).json({ error: 'Invalid status' });
  let prior = null;
  if (changes.status === 'approved') { const { data, error } = await supabase.from('whitelists').select('status,discord_id').eq('id', req.params.id).single(); if (error) throw error; prior = data; }
  const updated = await db.collection('whitelists').updateOne(req.params.id, { ...changes, updated_at: new Date().toISOString() });
  let approval_dm = null;
  if (changes.status === 'approved' && prior?.status !== 'approved') {
    try {
      const { error: commandError } = await supabase.from('launcher_commands').insert({ command:'refresh_whitelist', payload:{ player_id:updated.id }, status:'pending' });
      if (commandError) throw commandError;
    } catch (error) { console.error('[Launcher] Could not queue whitelist refresh:', error.message); }
    const notifyDiscordId = updated.discord_id || prior?.discord_id;
    if (!notifyDiscordId) approval_dm = { sent: false, reason: 'No Discord ID on this player row' };
    else {
      try { await sendDiscordApprovalDM(notifyDiscordId); approval_dm = { sent: true }; }
      catch (error) { console.error('[Discord] Approval DM failed:', error.message); approval_dm = { sent: false, reason: error.message }; }
    }
  }
  res.json({ ...updated, approval_dm });
} catch (e) { next(e); } });
app.delete('/api/whitelists/:id', async (req, res, next) => { try { res.json(await db.collection('whitelists').deleteOne(req.params.id)); } catch (e) { next(e); } });
app.post('/api/whitelists/sync-players', async (req, res, next) => { try {
  const { data: collection, error: collectionError } = await supabase.from('admin_collections').select('name').eq('id', req.body.collection_id).single(); if (collectionError) throw collectionError;
  if (collection.name !== 'players') return res.status(400).json({ error: 'เลือก players collection ก่อน' });
  const { data: docs, error: docsError } = await supabase.from('admin_documents').select('data').eq('collection_id', req.body.collection_id); if (docsError) throw docsError;
  const { data: prior, error: priorError } = await supabase.from('whitelists').select('steam_id,status,notes'); if (priorError) throw priorError;
  const existing = new Map(prior.map(p => [p.steam_id, p]));
  const rows = docs.map(({ data: p }) => { const steam_id = String(p.steamId || p.steam_id || (p.auth || []).find(a => a.authType === 'STEAM')?.extId || '').trim(); const old = existing.get(steam_id); const excluded = new Set(['steamId','steam_id','auth','session_token','profile','coin','amethyst','amulet','characterSlot','role','banStatus','playerRecord','stickerSlot','inventory','immortalData','isOnline','lastOnline']); const game_data = p.game_data && typeof p.game_data === 'object' ? p.game_data : Object.fromEntries(Object.entries(p).filter(([key]) => !excluded.has(key))); return { steam_id, discord_id: (p.auth || []).find(a => /discord/i.test(a.authType || ''))?.extId || null, player_name: p.profile?.displayName || null, status: old?.status || 'pending', notes: old?.notes || null, auth: p.auth || [], session_token: p.session_token || null, profile: p.profile || {}, coin: p.coin || 0, amethyst: p.amethyst || 0, amulet: p.amulet || 0, character_slot: p.characterSlot ?? null, role: p.role || 'survivor', ban_status: p.banStatus ?? null, player_record: p.playerRecord ?? null, sticker_slot: p.stickerSlot ?? null, inventory: p.inventory ?? null, immortal_data: p.immortalData || [], game_data, is_online: Boolean(p.isOnline), last_online: p.lastOnline || null, updated_at: new Date().toISOString() }; }).filter(p => p.steam_id);
  if (!rows.length) return res.json({ synced: 0 });
  const { data, error } = await supabase.from('whitelists').upsert(rows, { onConflict: 'steam_id' }).select('id'); if (error) throw error;
  res.json({ synced: data.length, scanned: docs.length });
} catch (e) { next(e); } });
app.get('/api/servers', async (req, res, next) => { try { const cid = await coreCollectionId('serverinfo'); const { data, error } = await supabase.from('admin_documents').select('*').eq('collection_id', cid).order('created_at'); if (error) throw error; res.json(data.map(d => ({ id: d.id, ...d.data }))); } catch (e) { next(e); } });
app.post('/api/servers', async (req, res, next) => { try { res.status(201).json(await db.collection('serverinfo').insertOne(cleanServer(req.body))); } catch (e) { next(e); } });
app.patch('/api/servers/:id', async (req, res, next) => { try { const changes = {}; for (const key of ['room_name','host_ip','port','max_players','is_online','server_version','extra']) if (Object.hasOwn(req.body,key)) changes[key] = req.body[key]; if (Object.hasOwn(changes,'port')) changes.port = Number(changes.port) || 0; if (Object.hasOwn(changes,'max_players')) changes.max_players = Number(changes.max_players) || 0; if (Object.hasOwn(changes,'is_online')) changes.is_online = changes.is_online === true || changes.is_online === 'true'; res.json(await db.collection('serverinfo').updateOne(req.params.id, { ...changes, updated_at: new Date().toISOString() })); } catch (e) { next(e); } });
app.delete('/api/servers/:id', async (req, res, next) => { try { res.json(await db.collection('serverinfo').deleteOne(req.params.id)); } catch (e) { next(e); } });
// Logical Mongo-like explorer: databases and collections are namespaces over PostgreSQL JSONB rows.
app.get('/api/explorer', async (req, res, next) => { try {
  const [{ data: databases, error: de }, { data: collections, error: ce }] = await Promise.all([
    supabase.from('admin_databases').select('*').order('created_at'),
    supabase.from('admin_collections').select('*').order('created_at')
  ]); if (de) throw de; if (ce) throw ce;
  res.json(databases.map(database => ({ ...database, collections: collections.filter(c => c.database_id === database.id) })));
} catch (e) { next(e); } });
app.post('/api/explorer/databases', async (req, res, next) => { try { const name = safeName(req.body.name); const { data, error } = await supabase.from('admin_databases').insert({ name }).select().single(); if (error) throw error; res.status(201).json(data); } catch (e) { next(e); } });
app.delete('/api/explorer/databases/:id', async (req, res, next) => { try { const { data: dbRow, error: lookupError } = await supabase.from('admin_databases').select('name').eq('id', req.params.id).single(); if (lookupError) throw lookupError; if (dbRow.name === 'HSHO-PrivateServer') return res.status(400).json({ error: 'ฐานข้อมูลหลักนี้ลบไม่ได้' }); const { error } = await supabase.from('admin_databases').delete().eq('id', req.params.id); if (error) throw error; res.json({ deleted: true }); } catch (e) { next(e); } });
app.post('/api/explorer/collections', async (req, res, next) => { try { const name = safeName(req.body.name); const { data, error } = await supabase.from('admin_collections').insert({ database_id: req.body.database_id, name }).select().single(); if (error) throw error; res.status(201).json(data); } catch (e) { next(e); } });
app.delete('/api/explorer/collections/:id', async (req, res, next) => { try { const { data: row, error: lookupError } = await supabase.from('admin_collections').select('name').eq('id', req.params.id).single(); if (lookupError) throw lookupError; if (['players','whitelists','serverinfo'].includes(row.name)) return res.status(400).json({ error: 'Collection หลักของระบบลบไม่ได้' }); const { error } = await supabase.from('admin_collections').delete().eq('id', req.params.id); if (error) throw error; res.json({ deleted: true }); } catch (e) { next(e); } });
app.get('/api/explorer/collections/:id/documents', async (req, res, next) => { try { const { data, error } = await supabase.from('admin_documents').select('*').eq('collection_id', req.params.id).order('created_at'); if (error) throw error; res.json(data); } catch (e) { next(e); } });
app.post('/api/explorer/collections/:id/documents', async (req, res, next) => { try { const { data, error } = await supabase.from('admin_documents').insert({ collection_id: req.params.id, data: req.body.data || {} }).select().single(); if (error) throw error; res.status(201).json(data); } catch (e) { next(e); } });
app.put('/api/explorer/collections/:id/raw-json', async (req, res, next) => { try { const docs = Array.isArray(req.body.documents) ? req.body.documents : null; if (!docs || docs.length > 2000 || docs.some(x => !x || typeof x !== 'object' || Array.isArray(x))) return res.status(400).json({ error: 'ใส่ JSON array ของ object ได้ไม่เกิน 2,000 รายการ' }); const { data: collection, error: ce } = await supabase.from('admin_collections').select('name').eq('id', req.params.id).single(); if (ce) throw ce; if (collection.name !== 'serverinfo') return res.status(400).json({ error: 'Raw JSON editor ใช้กับ serverinfo เท่านั้น' }); const { data, error } = await supabase.rpc('replace_admin_documents', { p_collection_id: req.params.id, p_documents: docs }); if (error) throw error; res.json(data); } catch (e) { next(e); } });
app.post('/api/explorer/collections/:id/import', async (req, res, next) => { try { const rows = req.body.documents; if (!Array.isArray(rows) || rows.length > 2000) return res.status(400).json({ error: 'ส่ง JSON array ได้ไม่เกิน 2,000 documents ต่อครั้ง' }); const payload = rows.map(data => ({ collection_id: req.params.id, data: data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data } })); if (!payload.length) return res.json({ inserted: 0 }); const { data, error } = await supabase.from('admin_documents').insert(payload).select('id'); if (error) throw error; res.status(201).json({ inserted: data.length }); } catch (e) { next(e); } });
app.patch('/api/explorer/documents/:id', async (req, res, next) => { try { const { data, error } = await supabase.from('admin_documents').update({ data: req.body.data || {}, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single(); if (error) throw error; res.json(data); } catch (e) { next(e); } });
app.delete('/api/explorer/documents/:id', async (req, res, next) => { try { const { error } = await supabase.from('admin_documents').delete().eq('id', req.params.id); if (error) throw error; res.json({ deleted: true }); } catch (e) { next(e); } });
app.post('/api/commands/kill-launchers', async (req, res, next) => { try { const command = await db.collection('launcher_commands').insertOne({ command: 'kill_all_launchers', payload: {}, status: 'pending' }); res.status(201).json(command); } catch (e) { next(e); } });
// Launcher-facing read-only endpoint; share this URL with the launcher integration.
app.get('/public/whitelist', async (req, res, next) => { try { const status = req.query.status || 'approved'; const rows = await db.collection('whitelists').find({ status }, { limit: 5000, orderBy: 'created_at', ascending: true }); res.set('Cache-Control', 'no-store').json({ updated_at: new Date().toISOString(), players: rows.map(({ steam_id, discord_id, player_name, status }) => ({ steam_id, discord_id, player_name, status })) }); } catch (e) { next(e); } });
app.get('/public/servers', async (req, res, next) => { try { const cid = await coreCollectionId('serverinfo'); const { data, error } = await supabase.from('admin_documents').select('data').eq('collection_id', cid).order('created_at').limit(100); if (error) throw error; const rows = data.map(x => x.data).filter(x => x.is_online !== false && x.IsOnline !== false); res.set('Cache-Control', 'no-store').json(rows); } catch (e) { next(e); } });
app.get('/public/game-data', async (req, res, next) => {
  try {
    if (req.query.path) {
      const item = await gameDataService.get(req.query.path);
      if (!item) return res.status(404).json({ error: 'Game data file not found' });
      return res.set('Cache-Control', 'public, max-age=60').json(item.data);
    }
    const files = await gameDataService.list();
    res.set('Cache-Control', 'no-store').json({ updated_at: new Date().toISOString(), files: files.map(({ file_path, sha256, updated_at }) => ({ path: file_path, sha256, updated_at })) });
  } catch (e) { next(e); }
});
async function readGameServerInfo() {
  const cid = await coreCollectionId('serverinfo');
  const { data, error } = await supabase.from('admin_documents').select('data').eq('collection_id', cid).order('created_at').limit(100);
  if (error) throw error;
  const records = (data || []).map(row => row.data).filter(value => value && typeof value === 'object' && !Array.isArray(value));
  const info = records.find(value => readBoolean(value.IsOnline ?? value.is_online, true)) || records[0];
  if (!info) throw new Error('ServerInfo is not configured in Cluster0 / HSHO-PrivateServer / serverinfo');
  const version = String(info.serverVersion ?? info.server_version ?? '').trim();
  if (!version) throw new Error('ServerInfo serverVersion is missing');
  return { serverInfo: {
    ...info,
    correctversion: readBoolean(info.correctversion ?? info.correctVersion, true),
    serverVersion: version,
    ServerDevVersion: String(info.ServerDevVersion ?? info.serverDevVersion ?? '0.0.0.1'),
    IsOnline: readBoolean(info.IsOnline ?? info.is_online, true),
    IsDevOnline: readBoolean(info.IsDevOnline ?? info.is_dev_online, false)
  } };
}
app.get(['/live/player/authen', '/live/player/auth'], (_req, res) => gameError(res, 405, 'Steam authentication requires a POST request from the game'));
const handleSteamGameAuth = async (req, res) => {
  const requestFields = listSafeGameFieldNames(req.body);
  recordAdminLog('info', 'Steam Auth', `Received POST /live/player/authen; fields=${requestFields.join(',') || '(none)'}`);
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const authType = findGameAuthField(body, ['authType','auth_type','platform','provider']);
    if (String(authType || '').toLowerCase() !== 'steam') {
      const safeType = typeof authType === 'string' || typeof authType === 'number' ? String(authType).slice(0, 32) : typeof authType;
      recordAdminLog('warn', 'Steam Auth', `Rejected request: expected authType=steam; received ${safeType}; content-type=${String(req.get('content-type') || 'missing').slice(0, 80)}; fields=${requestFields.join(',') || '(none)'}`, 400);
      return gameError(res, 400, 'Only Steam authentication is supported');
    }
    const ticketValue = findGameAuthField(body, ['ticket','steamTicket','sessionTicket','authTicket','steamSessionTicket','hexTicket']);
    const ticket = String(ticketValue || '').trim();
    if (!/^(?:[a-f0-9]{2}){20,8192}$/i.test(ticket)) { recordAdminLog('warn', 'Steam Auth', 'Rejected request: Steam ticket missing or malformed', 400); return gameError(res, 400, 'A valid Steam session ticket is required'); }

    const webApiKey = String(process.env.STEAM_WEB_API_KEY || '').trim();
    const publisherKey = String(process.env.STEAM_PUBLISHER_KEY || '').trim();
    const steamApiKey = webApiKey || publisherKey;
    // This game uses Steam App ID 480; allow Render to override it if needed.
    const appId = String(process.env.STEAM_APP_ID || '480').trim();
    const defaultSteamHost = publisherKey && !webApiKey ? 'partner.steam-api.com' : 'api.steampowered.com';
    const steamHost = String(process.env.STEAM_API_HOST || defaultSteamHost).trim().toLowerCase();
    if (!steamApiKey || !/^\d+$/.test(appId) || !['api.steampowered.com', 'partner.steam-api.com'].includes(steamHost)) { recordAdminLog('error', 'Steam Auth', 'Steam ticket validation environment is incomplete or invalid', 503); return gameError(res, 503, 'Steam ticket validation is not configured'); }
    const steamUrl = new URL(`https://${steamHost}/ISteamUserAuth/AuthenticateUserTicket/v1/`);
    steamUrl.searchParams.set('key', steamApiKey);
    steamUrl.searchParams.set('appid', appId);
    steamUrl.searchParams.set('ticket', ticket);
    if (process.env.STEAM_TICKET_IDENTITY) steamUrl.searchParams.set('identity', process.env.STEAM_TICKET_IDENTITY);
    const steamResponse = await fetch(steamUrl, { signal: AbortSignal.timeout(12000) });
    const steamBody = await steamResponse.text();
    const steamContentType = steamResponse.headers.get('content-type') || 'unknown';
    if (!steamResponse.ok) {
      // Do not log the request URL; it contains the private API key and ticket.
      console.warn('[Steam Auth] Steam returned HTTP', steamResponse.status, 'content-type:', steamContentType);
      recordAdminLog('error', 'Steam Auth', `Steam returned HTTP ${steamResponse.status} (${steamContentType})`, 502);
      return gameError(res, 502, `Steam authentication service returned HTTP ${steamResponse.status}`);
    }
    let steamPayload;
    try { steamPayload = JSON.parse(steamBody); }
    catch {
      console.warn('[Steam Auth] Steam returned non-JSON response; content-type:', steamContentType);
      recordAdminLog('error', 'Steam Auth', `Steam returned non-JSON response (${steamContentType})`, 502);
      return gameError(res, 502, 'Steam authentication service returned an invalid response');
    }
    const steamId = String(steamPayload?.response?.params?.steamid || '');
    if (!/^\d{17}$/.test(steamId)) {
      const steamParams = steamPayload?.response?.params && typeof steamPayload.response.params === 'object' ? steamPayload.response.params : {};
      const steamError = steamPayload?.response?.error && typeof steamPayload.response.error === 'object' ? steamPayload.response.error : {};
      const safeValue = value => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_. -]/g, '').slice(0, 48) || 'unknown';
      const result = safeValue(steamParams.result ?? steamParams.resultcode);
      const errorCode = safeValue(steamError.errorcode ?? steamPayload?.error?.errorcode);
      const responseFields = Object.keys(steamParams).slice(0, 12).join(',') || '(none)';
      recordAdminLog('warn', 'Steam Auth', `Steam rejected ticket; result=${result}; error_code=${errorCode}; response_fields=${responseFields}`, 401);
      return gameError(res, 401, 'Steam rejected the session ticket');
    }

    const row = await whitelistRepository.findBySteamId(steamId);
    if (!row) { recordAdminLog('warn', 'Steam Auth', 'Authenticated SteamID is absent from whitelist', 403); return gameError(res, 403, 'Steam account is not on the whitelist'); }
    if (row.status === 'banned' || isBanActive(row.ban_status)) { recordAdminLog('warn', 'Steam Auth', 'Whitelist rejected: player is banned', 403); return gameError(res, 403, 'Your account has been banned'); }
    if (row.status !== 'approved') { recordAdminLog('warn', 'Steam Auth', `Whitelist rejected: status is ${row.status}`, 403); return gameError(res, 403, 'Your whitelist is not approved'); }

    // Load ServerInfo before updating session state so configuration failures
    // are reported clearly and do not leave a half-created login session.
    const { serverInfo } = await readGameServerInfo();
    const playerData = await playerDataService.getOrCreatePlayerData(steamId, row.player_name || 'Player_' + steamId.slice(-6));
    recordAdminLog('info', 'Steam Auth', 'Steam ticket and whitelist passed; ServerInfo loaded');

    const now = new Date().toISOString();
    const sessionToken = issueGameSessionToken(steamId);
    const authEntries = Array.isArray(row.auth) ? [...row.auth] : structuredClone(authTemplate.data.player.auth || []);
    const steamAuth = { ...(authEntries.find(item => item && String(item.authType).toUpperCase() === 'STEAM') || authTemplate.data.player.auth[0]), authType: 'STEAM', extId: steamId, authAt: now };
    const otherAuth = authEntries.filter(item => item && String(item.authType).toUpperCase() !== 'STEAM');
    const updatedAuth = [steamAuth, ...otherAuth];
    const saved = await whitelistRepository.saveGameSession(row.id, { auth: updatedAuth, session_token: sessionToken, is_online: true, last_online: now });

    const response = structuredClone(authTemplate);
    const player = response.data.player;
    Object.assign(player, saved.game_data || {});
    player._id = steamId;
    player.auth = updatedAuth;
    player.session_token = sessionToken;
    player.profile = { ...player.profile, ...(saved.profile || {}), displayName: saved.player_name || saved.profile?.displayName || `Player_${steamId.slice(-6)}`, updatedAt: now };
    const savedSlots = saved.character_slot && typeof saved.character_slot === 'object' && !Array.isArray(saved.character_slot)
      ? saved.character_slot : null;
    // The database row is the durable source of truth. In particular, an
    // intentionally empty slot list is still saved state and must not fall
    // back to template cosmetics on every login.
    player.characterSlot = savedSlots ?? playerData.characterSlot ?? player.characterSlot;
    player.role = saved.role ?? playerData.role ?? player.role;
    player.stickerSlot = saved.sticker_slot ?? playerData.stickerSlot ?? player.stickerSlot;
    player.inventory = toLegacyInventory(saved.inventory ?? playerData.inventory, player.inventory);
    // Currency defaults are seeded and persisted once by PlayerDataService.
    // Do not turn a legitimate saved zero into 6,000 in the response.
    player.coin = Number(saved.coin ?? playerData.coin ?? 0);
    player.amethyst = Number(saved.amethyst ?? playerData.amethyst ?? 0);
    player.amulet = Number(saved.amulet ?? playerData.amulet ?? 0);
    player.banStatus = saved.ban_status ?? playerData.banStatus ?? player.banStatus;
    player.playerRecord = saved.player_record ?? playerData.playerRecord ?? player.playerRecord;
    player.isOnline = true;
    player.lastOnline = now;
    response.data.session_token = sessionToken;
    response.data.serverInfo = serverInfo;
    response.error = null;
    recordAdminLog('info', 'Steam Auth', 'Authentication completed successfully', 200);
    res.status(200).json(response);
  } catch (error) {
    console.error('[Steam Auth]', error.message);
    recordAdminLog('error', 'Steam Auth', error.message || 'Authentication failed', 503);
    gameError(res, 503, 'Steam authentication could not be completed');
  }
};
// Both game-client auth paths use the same real Steam ticket validation flow.
app.post(['/live/player/authen', '/live/player/auth'], handleSteamGameAuth);
app.get('/live/player/gameplay/checkversion', async (_req, res) => { try {
  const cid = await coreCollectionId('serverinfo');
  const { data, error } = await supabase.from('admin_documents').select('data').eq('collection_id', cid).order('created_at').limit(100);
  if (error) throw error;
  const records = (data || []).map(row => row.data).filter(x => x && typeof x === 'object' && !Array.isArray(x));
  const info = records.find(x => readBoolean(x.IsOnline ?? x.is_online, true)) || records[0];
  if (!info) return res.status(503).json({ status: 0, data: null, error: 'ServerInfo is not configured' });
  const version = String(info.serverVersion ?? info.server_version ?? '').trim();
  if (!version) return res.status(503).json({ status: 0, data: null, error: 'ServerInfo serverVersion is missing' });
  const serverInfo = { correctversion: readBoolean(info.correctversion ?? info.correctVersion, true), serverVersion: version, ServerDevVersion: String(info.ServerDevVersion ?? info.serverDevVersion ?? '0.0.0.1'), IsOnline: readBoolean(info.IsOnline ?? info.is_online, true), IsDevOnline: readBoolean(info.IsDevOnline ?? info.is_dev_online, false) };
  res.set('Cache-Control', 'no-store').json({ status: 1, data: { serverInfo }, error: null });
} catch (e) { console.error('[Game API checkversion GET]', e); res.status(503).json({ status: 0, data: null, error: 'Could not load ServerInfo from Supabase' }); } });
app.post('/live/player/gameplay/checkversion', async (req, res, next) => { try {
  const cid = await coreCollectionId('serverinfo');
  const { data: docs, error: docsError } = await supabase.from('admin_documents').select('data').eq('collection_id', cid).order('created_at').limit(100);
  if (docsError) throw docsError;
  const records = (docs || []).map(row => row.data).filter(x => x && typeof x === 'object' && !Array.isArray(x));
  const info = records.find(x => readBoolean(x.IsOnline ?? x.is_online, true)) || records[0];
  if (!info) return res.status(503).json({ status: 0, data: null, error: 'ServerInfo is not configured' });
  const version = String(info.serverVersion ?? info.server_version ?? '').trim();
  if (!version) return res.status(503).json({ status: 0, data: null, error: 'ServerInfo serverVersion is missing' });
  const serverInfo = {
    correctversion: readBoolean(info.correctversion ?? info.correctVersion, true),
    serverVersion: version,
    ServerDevVersion: String(info.ServerDevVersion ?? info.serverDevVersion ?? '0.0.0.1'),
    IsOnline: readBoolean(info.IsOnline ?? info.is_online, true),
    IsDevOnline: readBoolean(info.IsDevOnline ?? info.is_dev_online, false)
  };
  if (!serverInfo.IsOnline) return res.status(200).json({ status: 0, data: { serverInfo: { ...serverInfo, correctversion: false } }, error: 'Server cannot be played during maintenance' });
  const clientVersion = req.body?.clientversion ?? req.body?.clientVersion;
  if (clientVersion !== version) return res.status(200).json({ status: 0, data: { serverInfo: { ...serverInfo, correctversion: false } }, error: 'Client version mismatch. Please update your game.' });

  const playerId = req.body?.playerId ?? req.body?.Player?.[0]?.playerId;
  if (playerId !== undefined && playerId !== null && String(playerId).trim()) {
    const { data: player, error: playerError } = await supabase.from('whitelists').select('steam_id,status').eq('steam_id', String(playerId).trim()).maybeSingle();
    if (playerError) throw playerError;
    if (!player) return res.status(200).json({ status: 0, data: { serverInfo }, error: 'Invalid player ID.' });
    if (player.status === 'banned') return res.status(403).json({ status: 0, data: null, error: 'Your account has been banned' });
    if (player.status !== 'approved') return res.status(403).json({ status: 0, data: null, error: 'Your whitelist is not approved' });
  }
  res.json({ status: 1, data: { serverInfo }, error: null });
} catch (e) { console.error('[Game API checkversion]', e); res.status(503).json({ status: 0, data: null, error: 'Could not load ServerInfo from Supabase' }); } });
app.get('/public/launcher-config', async (req, res) => {
  let base;
  try { base = await launcherBaseUrl(req); } catch (error) { console.error('[Launcher Config]', error.message); return res.status(503).json({ error: 'Could not load Launcher Host setting' }); }
  let discord_verify_url = '';
  const botUrl = String(process.env.DISCORD_BOT_API_URL || '').trim().replace(/\/+$/, '');
  if (botUrl) {
    try { const response = await fetch(`${botUrl}/public/verify-link`); if (response.ok) discord_verify_url = (await response.json()).url || ''; }
    catch (error) { console.warn('[Discord] Could not load verify link:', error.message); }
  }
  const verifyServiceUrl = String(process.env.LAUNCHER_VERIFY_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  res.set('Cache-Control','no-store').json({ host: base, serverinfo_url: publishedServerInfoUrl(req, base), game_data_url: `${base}/public/game-data`, auth_url: `${base}/live/player/authen`, game_api_url: `${base}/live/player/gameplay/checkversion`, whitelist_url: `${base}/public/whitelist`, discord_verify_url, discord_login_url: verifyServiceUrl ? `${verifyServiceUrl}/oauth/launcher` : '' });
});
app.get('/public/launcher-update', async (_req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'launcher_update_manifest').maybeSingle();
    if (error) throw error;
    const manifest = data?.value;
    if (!manifest?.version || !manifest?.object_path || !manifest?.sha256) return res.status(204).end();
    const { data: signed, error: signError } = await supabase.storage.from('launcher-updates').createSignedUrl(manifest.object_path, 600);
    if (signError) throw signError;
    res.set('Cache-Control', 'no-store').json({ version: manifest.version, url: signed.signedUrl, sha256: manifest.sha256, notes: manifest.notes || '', published_at: manifest.published_at || null });
  } catch (e) { next(e); }
});
// Game-client adapters use the verified Steam session and the player's
// existing Supabase whitelist/save row. Register these before the generic
// game routers so no older handler can shadow them.
async function configuredGameServerTarget() {
  let host = String(process.env.GAME_SERVER_HOST || '').trim();
  let port = Number(process.env.GAME_SERVER_PORT || 0);
  if (!host || !port) {
    try {
      const { serverInfo } = await readGameServerInfo();
      host ||= String(serverInfo.gameServerHost ?? serverInfo.game_server_host ?? serverInfo.serverIp ?? serverInfo.server_ip ?? serverInfo.hostIp ?? serverInfo.host_ip ?? '').trim();
      port ||= Number(serverInfo.gameServerPort ?? serverInfo.game_server_port ?? serverInfo.serverPort ?? serverInfo.server_port ?? serverInfo.port ?? 0);
      if ((!host || !port) && serverInfo.extra && typeof serverInfo.extra === 'object') {
        host ||= String(serverInfo.extra.gameServerHost ?? serverInfo.extra.serverIp ?? serverInfo.extra.hostIp ?? '').trim();
        port ||= Number(serverInfo.extra.gameServerPort ?? serverInfo.extra.serverPort ?? serverInfo.extra.port ?? 0);
      }
    } catch (error) {
      if (process.env.GAME_SERVER_HOST || process.env.GAME_SERVER_PORT) throw error;
    }
  }
  // A loopback address only points back to each player's own computer.
  if (!host || /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    return null;
  if (/[\s/?#]/.test(host) || host.includes('://')) return null;
  return { serverIp: host, serverPort: port, connectionAddress: `${host}:${port}` };
}

function normalizeGameLobbyResult(value, serverTarget) {
  const result = value && typeof value === 'object' ? value : {};
  const lobby = result.lobby && typeof result.lobby === 'object' ? result.lobby : null;
  return {
    ...result,
    ...(lobby ? { lobby: { ...lobby, ...serverTarget }, lobbyId: lobby.id, roomId: lobby.room_code || lobby.id } : {}),
    ...(serverTarget || {}),
  };
}

async function gameRpc(req, res, rpcName, args, { requireServer = false, includeServerTarget = true } = {}) {
  try {
    if (!supabase) return gameError(res, 503, 'Game database is not configured');
    await respondWithAuthedGamePlayer(req, res, async player => {
      const serverTarget = includeServerTarget || requireServer ? await configuredGameServerTarget() : null;
      if (requireServer && !serverTarget) return gameError(res, 503, 'Dedicated game server host and port are not configured');
      const { data, error } = await supabase.rpc(rpcName, { p_steam_id: player.steamId, ...args,
        ...(includeServerTarget && serverTarget ? { p_server_ip: serverTarget.serverIp, p_server_port: serverTarget.serverPort } : {}) });
      if (error) {
        recordAdminLog('warn', 'Matchmaking', `${rpcName} failed (${error.code || 'database error'})`, 409);
        return gameError(res, error.code === 'P0001' ? 409 : 503, error.code === 'P0001' ? cleanRoomText(error.message, 120) : 'Matchmaking request failed');
      }
      const payload = normalizeGameLobbyResult(data, serverTarget);
      res.set('Cache-Control', 'no-store').status(200).json({ status: 1, data: payload, error: null });
    });
  } catch (error) {
    console.error(`[${rpcName}]`, error.message);
    recordAdminLog('error', 'Matchmaking', `${rpcName} could not complete`, 503);
    if (!res.headersSent) gameError(res, 503, 'Matchmaking request could not complete');
  }
}

async function serveGamePlayerProfile(req, res) {
  try {
    await respondWithAuthedGamePlayer(req, res, async player => {
      const row = await whitelistRepository.findBySteamId(player.steamId);
      if (!row) return gameError(res, 404, 'Player save was not found');
      const playerData = playerSaveDocument(row);
      playerData.steamid = player.steamId;
      const data = {
        player: playerData,
        profile: row.profile || {},
        level: Number(row.profile?.level ?? row.game_data?.level ?? 0),
        mmr: Number(row.profile?.mmr ?? row.game_data?.mmr ?? 0),
        currencies: { coin: Number(row.coin || 0), amethyst: Number(row.amethyst || 0), amulet: Number(row.amulet || 0) },
        characterSlot: row.character_slot || null,
        stickerSlot: row.sticker_slot || null,
        inventory: row.inventory || null,
        playerRecord: row.player_record || null,
        immortalData: row.immortal_data || [],
      };
      res.set('Cache-Control', 'no-store').json({ status: 1, data, error: null });
    });
  } catch (error) {
    console.error('[Game Player Profile]', error.message);
    if (!res.headersSent) gameError(res, 503, 'Player data could not be loaded');
  }
}
app.get('/live/player/profile', serveGamePlayerProfile);
app.post('/live/player/profile', serveGamePlayerProfile);

app.post('/live/lobby/create', async (req, res) => {
  const target = await configuredGameServerTarget().catch(() => null);
  if (!target) return gameError(res, 503, 'Configure GAME_SERVER_HOST and GAME_SERVER_PORT before creating game lobbies');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = cleanRoomText(body.roomName ?? body.room_name ?? body.name ?? 'HSHO Room', 48);
  const gameMode = cleanRoomText(body.gameMode ?? body.game_mode ?? body.mode ?? 'default', 32) || 'default';
  const region = cleanRoomText(body.region ?? 'auto', 24) || 'auto';
  const displayName = cleanRoomText(body.displayName ?? body.playerName ?? 'Player', 32) || 'Player';
  const maxPlayers = Number(body.maxPlayers ?? body.max_players ?? 5);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 16) return gameError(res, 400, 'maxPlayers must be an integer from 2 to 16');
  return gameRpc(req, res, 'game_room_create', { p_name: name, p_game_mode: gameMode, p_region: region, p_max_players: maxPlayers, p_display_name: displayName }, { requireServer: true });
});

app.post('/live/matchmaking/search', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const target = await configuredGameServerTarget().catch(() => null);
  return gameRpc(req, res, 'game_matchmaking_search', {
    p_game_mode: cleanRoomText(body.gameMode ?? body.game_mode ?? body.mode ?? 'default', 32) || 'default',
    p_region: cleanRoomText(body.region ?? 'auto', 24) || 'auto',
    p_display_name: cleanRoomText(body.displayName ?? body.playerName ?? 'Player', 32) || 'Player',
    p_server_ip: target?.serverIp || null, p_server_port: target?.serverPort || null,
  });
});

app.post('/live/lobby/join', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const lobbyKey = cleanRoomText(body.lobbyId ?? body.lobby_id ?? body.roomId ?? body.roomCode ?? body.room_code ?? body.id ?? '', 64);
  if (!lobbyKey) return gameError(res, 400, 'lobbyId or roomCode is required');
  const target = await configuredGameServerTarget().catch(() => null);
  return gameRpc(req, res, 'game_room_join', { p_lobby_key: lobbyKey, p_display_name: cleanRoomText(body.displayName ?? body.playerName ?? 'Player', 32) || 'Player', p_server_ip: target?.serverIp || null, p_server_port: target?.serverPort || null });
});

app.post('/live/lobby/leave', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const lobbyKey = cleanRoomText(body.lobbyId ?? body.lobby_id ?? body.roomId ?? body.roomCode ?? body.room_code ?? body.id ?? '', 64);
  return gameRpc(req, res, 'game_room_leave', { p_lobby_key: lobbyKey || null }, { includeServerTarget: false });
});

app.post('/live/matchmaking/cancel', async (req, res) => gameRpc(req, res, 'game_matchmaking_cancel', {}, { includeServerTarget: false }));
app.post(['/live/matchmaking/status', '/live/lobby/status'], async (req, res) =>
  gameRpc(req, res, 'game_matchmaking_status', {}, { includeServerTarget: false }));

app.use('/', gameHealthRoutes);
// The game API adapters in src use Supabase repositories and static JSON rows.
// Existing auth/checkversion handlers above take precedence; remaining routes
// are served by the adapted game API router.
app.use('/', require('./src/routes/index'));
// The client posts gameplay diagnostics here. Keep the report useful without
// persisting request bodies wholesale (they may contain session credentials).
app.post('/logapi/v1/add/errorlog', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const safeText = value => String(value ?? '')
    .replace(/(ticket|session[_-]?token|access[_-]?token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b(?:[a-f0-9]{40,}|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 180);
  const details = Object.entries(body)
    .filter(([key, value]) => !/ticket|token|secret|key|steamid|discordid|authorization/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 5)
    .map(([key, value]) => `${safeText(key)}=${safeText(value)}`);
  recordAdminLog('warn', 'Game Error', details.length ? details.join('; ') : `Received client error report; fields=${Object.keys(body).filter(key => !/ticket|token|secret|key|steamid|discordid|authorization/i.test(key)).slice(0, 12).join(',') || '(none)'}`, 200);
  res.status(200).json({ status: 'success' });
});
async function respondWithAuthedGamePlayer(req, res, action) {
  const token = String(req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-access-token'] || findGameAuthField(req.body, ['session_token','sessionToken']) || '').trim();
  const steamId = verifyGameSessionToken(token);
  if (!steamId) { gameError(res, 401, 'A valid player session is required'); return; }
  const player = await PlayerModel.findOne({ steamId });
  if (!player || player.session_token !== token) { gameError(res, 401, 'Player session is expired or replaced'); return; }
  if (player.status !== 'approved' || player.status === 'banned' || isBanActive(player.banStatus)) { gameError(res, 403, 'Player is not allowed to use this endpoint'); return; }
  await action(player);
}
function unwrapGameSavePayload(body) {
  let payload = body;
  if (Array.isArray(payload)) {
    // Some Unreal export/bridge callers serialize a single SaveGame object in
    // an array. Select only the entry that actually contains player fields.
    payload = payload.find(item => item && typeof item === 'object' &&
      (item.S_PlayerInfo || item.s_player_info || item.Properties || item.properties ||
       Object.keys(item).some(key => [...PLAYER_SAVEGAME_CUSTOMIZATION_FIELDS].some(field => matchesGameSaveField(key, field))))) || {};
  }
  if (!payload || typeof payload !== 'object') return {};
  const wrappers = new Set(['playerdata','payload','data','player','savegame','playersavegame','request','body']);
  const seen = new Set();
  for (let depth = 0; depth < 8 && payload && typeof payload === 'object' && !Array.isArray(payload) && !seen.has(payload); depth++) {
    seen.add(payload);
    const entries = Object.entries(payload);
    const hasPlayerFields = entries.some(([key]) =>
      [...PLAYER_SAVEGAME_CUSTOMIZATION_FIELDS].some(field => matchesGameSaveField(key, field)) ||
      ['splayerinfo','characterSlot','character_slot','loadout','equippedSkins','selectedCharacter'].includes(normalizeGameFieldName(key)));
    if (hasPlayerFields) break;
    const nested = entries.find(([key, value]) => wrappers.has(normalizeGameFieldName(key)) && value && typeof value === 'object');
    if (!nested) break;
    payload = Array.isArray(nested[1]) ? nested[1][0] : nested[1];
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}
function pickGameSaveValue(payload, names) {
  if (!payload || typeof payload !== 'object') return undefined;
  const matches = key => names.some(name => matchesGameSaveField(key, name));
  for (const [key, value] of Object.entries(payload)) if (matches(key)) return value;
  // Unreal commonly wraps values in Properties/S_PlayerInfo and the API
  // bridge may add another data/player envelope. Search boundedly, while
  // skipping credential branches and avoiding cycles/unbounded client JSON.
  const queue = [[payload, 0]];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited++ < 2000) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) continue;
    seen.add(node);
    const entries = Array.isArray(node) ? node.map((value, index) => [String(index), value]) : Object.entries(node);
    for (const [key, value] of entries) if (matches(key)) return value;
    for (const [key, value] of entries) {
      if (/ticket|session|token|secret|authorization|credential/i.test(key)) continue;
      if (value && typeof value === 'object') queue.push([value, depth + 1]);
    }
  }
  return undefined;
}
// Unreal export JSON names user-defined struct fields like
// `DefaultCharacter_58_A0FB...` (field index + 32-character GUID). Runtime
// JSON often uses the clean name, so accept both forms while requiring the
// exact Unreal suffix shape to avoid accidentally matching unrelated keys.
function matchesGameSaveField(candidate, expected) {
  const actual = normalizeGameFieldName(candidate);
  const base = normalizeGameFieldName(expected);
  return actual === base || new RegExp(`^${base}\\d+[a-f0-9]{32}$`).test(actual);
}
// PlayerSaveGame.json is an Unreal export. These are the client-owned
// appearance/loadout fields from its S_PlayerInfo struct that can safely be
// persisted as JSONB. Identity, wallet, ownership, and inventory remain
// server-authoritative and are intentionally excluded.
const PLAYER_SAVEGAME_CUSTOMIZATION_FIELDS = new Set([
  'DefaultCharacter','CharacterItem','CharacterHunterItem','StickerPreset',
  'SurvivorSlots','HunterSlots','StickerAssets','FrameImage',
  'PlayerCharacterInfo','CurseSlots','RelicSlots',
]);
const PLAYER_SAVEGAME_UNREAL_FIELDS = {
  DefaultCharacter: 'DefaultCharacter_58_A0FB71274BD1A1149454D5BA5844F62D',
  CharacterItem: 'CharacterItem_92_4D600D7B4AA8AEF823F8EABF937B8163',
  CharacterHunterItem: 'CharacterHunterItem_79_E7DF4A37453201890FFBE1A8CAAA4870',
  StickerPreset: 'StickerPreset_128_50948BB14FFC563D32896EB7F8AF9FCB',
  SurvivorSlots: 'SurvivorSlots_90_07CE3003426039B5002958BE668DA7BE',
  HunterSlots: 'HunterSlots_91_2927702B499D1DEBE923E0935011AA35',
  StickerAssets: 'StickerAssets_121_E781DF3A46715283D73953966AA1F1BC',
  FrameImage: 'FrameImage_177_1F266F0844EC07BEDF59F3964E1B1D60',
  PlayerCharacterInfo: 'PlayerCharacterInfo_156_38BD7A554EBF3133B1A95C999F006268',
  CurseSlots: 'CurseSlots_171_1DFCBCD14A35F106D181D1B23488C2A8',
  RelicSlots: 'RelicSlots_172_067885774C69D8BBF4A4DF9092F726F0',
};
function extractPlayerSaveGameCustomization(payload) {
  const source = pickGameSaveValue(payload, ['S_PlayerInfo','s_player_info','PlayerSaveGame','playerSaveGame','playerInfo','PlayerInfo'])
    ?? (payload.Properties || payload.properties || Object.keys(payload).some(key => [...PLAYER_SAVEGAME_CUSTOMIZATION_FIELDS].some(field => matchesGameSaveField(key, field))) ? payload : null);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  // Support the exported Unreal shape ({ Properties: { S_PlayerInfo: ... } })
  // as well as the runtime shape (the struct object itself).
  const properties = source.Properties ?? source.properties ?? source;
  const info = properties.S_PlayerInfo ?? properties.s_player_info ?? properties;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const customization = {};
  const unrealFields = {};
  for (const [key, value] of Object.entries(info)) {
    const canonicalField = [...PLAYER_SAVEGAME_CUSTOMIZATION_FIELDS].find(field => matchesGameSaveField(key, field));
    if (!canonicalField) continue;
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 200 * 1024) throw new Error(`${key} is too large`);
    customization[canonicalField] = safeGameSnapshot(value);
    // Keep the exact Blueprint property name as well as a clean alias. The
    // game/export uses GUID-suffixed names; dropping them on the response can
    // make a saved outfit appear to revert when the client reloads its struct.
    unrealFields[key] = safeGameSnapshot(value);
  }
  return Object.keys(customization).length ? { customization, unrealFields } : null;
}
function mergePlayerSaveGame(player, extracted) {
  if (!extracted?.customization) return false;
  const previous = player.PlayerSaveGame && typeof player.PlayerSaveGame === 'object' && !Array.isArray(player.PlayerSaveGame)
    ? player.PlayerSaveGame : {};
  const previousInfo = previous.S_PlayerInfo && typeof previous.S_PlayerInfo === 'object' && !Array.isArray(previous.S_PlayerInfo)
    ? previous.S_PlayerInfo : {};
  player.PlayerSaveGame = {
    ...previous,
    ...extracted.customization,
    S_PlayerInfo: { ...previousInfo, ...extracted.unrealFields },
  };
  // Preserve the clean aliases for our admin tools and older clients too.
  for (const [key, value] of Object.entries(extracted.customization)) player[key] = value;
  return true;
}
async function persistGameCustomization(player, requestBody) {
  const payload = unwrapGameSavePayload(requestBody);
  const updates = {};
  const extractedSaveGame = extractPlayerSaveGameCustomization(payload);
  const saveGameCustomization = extractedSaveGame?.customization;
  if (saveGameCustomization) {
    mergePlayerSaveGame(player, extractedSaveGame);
    updates.PlayerSaveGame = Object.keys(saveGameCustomization);
  }
  const slotValue = pickGameSaveValue(payload, ['characterSlot','character_slot','slots']);
  const loadout = pickGameSaveValue(payload, ['loadout','Loadout']);
  const slotKeys = ['hunterSlot','survivorSlot','characterhunteritem','characteritem','character'];
  const loadoutIsSlotData = loadout && typeof loadout === 'object' && !Array.isArray(loadout)
    && slotKeys.some(key => Object.hasOwn(loadout, key));
  const hasDirectSlotData = slotKeys.some(key => pickGameSaveValue(payload, [key]) !== undefined);
  const slots = slotValue && typeof slotValue === 'object' && !Array.isArray(slotValue)
    ? slotValue : loadoutIsSlotData ? loadout : hasDirectSlotData ? payload : null;
  const role = pickGameSaveValue(payload, ['role','playerRole']);
  if (slots) {
    const normalized = {};
    for (const key of ['hunterSlot','survivorSlot','characterhunteritem','characteritem']) {
      const value = pickGameSaveValue(slots, [key]);
      if (value !== undefined) normalized[key] = value;
    }
    const selectedSlotCharacter = pickGameSaveValue(slots, ['character']);
    if (selectedSlotCharacter !== undefined) {
      const character = String(selectedSlotCharacter || '');
      const collection = character.startsWith('Hunter_') ? 'hunterSlot'
        : character.startsWith('Survivor_') ? 'survivorSlot' : null;
      if (!collection) throw new Error('selected character has an invalid character ID');
      if (!normalized[collection]) normalized[collection] = [slots];
    }
    if (Object.keys(normalized).length) {
      await inventoryService.updateCharacterSlot(player, normalized, role);
      updates.characterSlot = player.characterSlot;
    }
  }

  // Persist extra customization state in the row's game_data JSONB via the
  // existing Player model. Never copy identity, session, moderation, or
  // server-managed economy/inventory fields from the client.
  const customizationFields = [
    ['loadout', ['loadout','Loadout']],
    ['equippedSkins', ['equippedSkins','equipped_skins']],
    ['selectedCharacter', ['selectedCharacter','selected_character']],
    ['PlayerSaveGame', ['PlayerSaveGame','playerSaveGame','S_PlayerInfo','s_player_info','playerInfo','PlayerInfo']],
  ];
  for (const [storedKey, aliases] of customizationFields) {
    const value = pickGameSaveValue(payload, aliases);
    if (value === undefined || (storedKey === 'loadout' && loadoutIsSlotData)) continue;
    if (storedKey === 'PlayerSaveGame' && saveGameCustomization) continue;
    const scalarCharacter = storedKey === 'selectedCharacter' && ['string','number'].includes(typeof value);
    if (value === null || (!scalarCharacter && typeof value !== 'object') || Buffer.byteLength(JSON.stringify(value), 'utf8') > 200 * 1024) {
      throw new Error(`${storedKey} must be JSON data under 200 KB`);
    }
    player[storedKey] = safeGameSnapshot(value);
    updates[storedKey] = player[storedKey];
  }
  const profile = pickGameSaveValue(payload, ['profile','Profile']);
  if (profile !== undefined) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('profile must be a JSON object');
    const safeProfile = safeGameSnapshot(profile);
    for (const key of Object.keys(safeProfile)) {
      if (/coin|currency|money|cash|amulet|amethyst|balance|inventory|item|steam|discord|token|auth|ban|status/i.test(key)) delete safeProfile[key];
    }
    player.profile = { ...(player.profile || {}), ...safeProfile };
    updates.profile = player.profile;
  }
  const stickerSlot = pickGameSaveValue(payload, ['stickerSlot','sticker_slot','stickerInfo']);
  if (stickerSlot !== undefined) {
    if (!stickerSlot || typeof stickerSlot !== 'object' || Array.isArray(stickerSlot)) throw new Error('stickerSlot must be a JSON object');
    player.stickerSlot = safeGameSnapshot(stickerSlot);
    updates.stickerSlot = player.stickerSlot;
  }
  const playerRecord = pickGameSaveValue(payload, ['playerRecord','player_record']);
  if (playerRecord !== undefined) {
    if (!playerRecord || typeof playerRecord !== 'object' || Array.isArray(playerRecord)) throw new Error('playerRecord must be a JSON object');
    player.playerRecord = safeGameSnapshot(playerRecord);
    updates.playerRecord = player.playerRecord;
  }
  const immortalData = pickGameSaveValue(payload, ['immortalData','immortal_data']);
  if (immortalData !== undefined) {
    if (!Array.isArray(immortalData)) throw new Error('immortalData must be an array');
    player.immortalData = safeGameSnapshot(immortalData);
    updates.immortalData = player.immortalData;
  }
  // Client currency and ownership claims are deliberately ignored. Purchases,
  // rewards, and inventory grants must be validated by server-side game rules.
  const ignoredClientManaged = ['currencies','currency','coin','amethyst','amulet','items','inventory']
    .filter(key => Object.hasOwn(payload, key));
  if (ignoredClientManaged.length) recordAdminLog('warn', 'Player Save', `Ignored client-managed fields: ${ignoredClientManaged.join(',')}`);

  if (Object.keys(updates).length) await player.save();
  return updates;
}
async function handleGameSaveRequest(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 512 * 1024) return gameError(res, 413, 'Player save payload is too large');
    await respondWithAuthedGamePlayer(req, res, async player => {
      const updated = await persistGameCustomization(player, body);
      const row = await whitelistRepository.findBySteamId(player.steamId);
      const profile = playerSaveDocument(row || {});
      profile.steamid = player.steamId;
      recordAdminLog('info', 'Player Save', `Saved authenticated player customization; fields=${Object.keys(updated).join(',') || 'no mutable state'}`, 200);
      res.set('Cache-Control', 'no-store').status(200).json({ success: true, status: 'success', code: 0, data: { profile } });
    });
  } catch (error) {
    console.error('[Player Save] game save request:', error.message);
    const invalid = /must be|invalid|too large|character ID/i.test(error.message);
    if (!res.headersSent) gameError(res, invalid ? 400 : 503, invalid ? error.message : 'Player data could not be saved');
  }
}
app.post(['/live/player/save','/live/player/updateLoadout','/live/profile/save','/live/inventory/update'], handleGameSaveRequest);
// Authenticated Save Data API. The SteamID always comes from the validated
// session; callers cannot read or overwrite another player's row by changing
// a request-body SteamID. Currency, inventory, whitelist, ban, and session
// fields remain server-managed and are never accepted as save mutations.
app.post('/api/getPlayerData', async (req, res) => {
  try {
    await respondWithAuthedGamePlayer(req, res, async player => {
      const row = await whitelistRepository.findBySteamId(player.steamId);
      if (!row) return res.status(404).json({ success: false, error: 'Player save not found' });
      const data = playerSaveDocument(row);
      data.steamid = player.steamId;
      res.set('Cache-Control', 'no-store').json({ success: true, data });
    });
  } catch (error) {
    console.error('[Player Save] getPlayerData:', error.message);
    res.status(503).json({ success: false, error: 'Player data could not be loaded' });
  }
});
app.post('/api/savePlayerData', async (req, res) => {
  try {
    await respondWithAuthedGamePlayer(req, res, async player => {
      const payload = req.body?.playerData ?? req.body?.data;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ success: false, error: 'playerData must be a JSON object' });
      }
      let split;
      try { split = splitPlayerSave(payload); }
      catch (error) { return res.status(400).json({ success: false, error: error.message }); }

      const mutableColumns = new Set(['profile','character_slot','sticker_slot','player_record','immortal_data']);
      const updates = {};
      for (const [column, value] of Object.entries(split)) {
        if (mutableColumns.has(column)) updates[column] = value;
      }

      if (Object.hasOwn(updates, 'character_slot')) {
        const slotData = updates.character_slot;
        delete updates.character_slot;
        await inventoryService.updateCharacterSlot(player, slotData);
      }
      if (Object.hasOwn(updates, 'profile')) player.profile = { ...(player.profile || {}), ...updates.profile };
      if (Object.hasOwn(updates, 'sticker_slot')) player.stickerSlot = updates.sticker_slot;
      if (Object.hasOwn(updates, 'player_record')) player.playerRecord = updates.player_record;
      if (Object.hasOwn(updates, 'immortal_data')) player.immortalData = updates.immortal_data;
      if (Object.keys(updates).length) await player.save();

      // Store additional non-reserved game fields in JSONB, without allowing
      // callers to smuggle identity, credentials, economy, or moderation fields.
      const protectedKeys = /^(steam_?id|csteamid|playerid|playersessionid|auth|session_?token|access_?token|status|ban_?status|inventory|playerinventoryinfo|characterlist|coin|gem|token|lootboxamount|amethyst|amulet|role|is_?online|last_?online)$/i;
      const extras = Object.fromEntries(Object.entries(split.game_data || {}).filter(([key]) => !protectedKeys.test(key)));
      if (Object.keys(extras).length) {
        for (const [key, value] of Object.entries(extras)) {
          if (/^(playersavegame|s_player_info|playerinfo)$/i.test(key)) {
            const customization = extractPlayerSaveGameCustomization({ [key]: value });
            if (customization) mergePlayerSaveGame(player, customization);
            continue;
          }
          player[key] = value;
        }
        await player.save();
      }

      const savedRow = await whitelistRepository.findBySteamId(player.steamId);
      const data = playerSaveDocument(savedRow);
      data.steamid = player.steamId;
      recordAdminLog('info', 'Player Save', 'Authenticated player data saved', 200);
      res.set('Cache-Control', 'no-store').json({ success: true, data });
    });
  } catch (error) {
    console.error('[Player Save] savePlayerData:', error.message);
    const status = /must be|too large|Invalid|contains invalid|must be an array/i.test(error.message) ? 400 : 503;
    res.status(status).json({ success: false, error: status === 400 ? error.message : 'Player data could not be saved' });
  }
});
function safeGameSnapshot(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || ['string','number','boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map(item => safeGameSnapshot(item, depth + 1));
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 300)) {
    if (/ticket|session[_-]?token|access[_-]?token|secret|api[_-]?key|authorization/i.test(key)) continue;
    result[key] = safeGameSnapshot(item, depth + 1);
  }
  return result;
}
app.post('/live/mailbox/get', async (req, res) => {
  try {
    await respondWithAuthedGamePlayer(req, res, async player => {
      const mailbox = Array.isArray(player.mailbox) ? player.mailbox : [];
      res.set('Cache-Control', 'no-store').json({ status: 1, data: { mails: mailbox }, error: null });
    });
  } catch (error) { console.error('[Mailbox]', error.message); gameError(res, 503, 'Mailbox data could not be loaded'); }
});
app.post('/live/treasure/api/progress/get', async (req, res) => {
  try {
    await respondWithAuthedGamePlayer(req, res, async player => {
      const progress = player.treasureProgress && typeof player.treasureProgress === 'object' ? player.treasureProgress : {};
      res.set('Cache-Control', 'no-store').json({ status: 1, data: { progress }, error: null });
    });
  } catch (error) { console.error('[Treasure Progress]', error.message); gameError(res, 503, 'Treasure progress could not be loaded'); }
});
app.post('/live/player/gameplay/endgameresult', async (req, res) => {
  try {
    await respondWithAuthedGamePlayer(req, res, async player => {
      const snapshot = safeGameSnapshot(req.body);
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 512 * 1024) return gameError(res, 413, 'Game result payload is too large');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const receivedFields = listSafeGameFieldNames(body);
      // Some client builds include the final loadout/inventory snapshot in
      // endgameresult rather than calling a dedicated save route. Persist the
      // recognized customization fields here as well; the helper merges slots
      // and ignores client-supplied currency/item ownership claims.
      const savedCustomization = await persistGameCustomization(player, body);
      player.lastGameResult = snapshot;
      player.lastGameResultAt = new Date().toISOString();
      await player.save();
      recordAdminLog('info', 'Player Save', `End-game snapshot persisted; received=${receivedFields.join(',') || '(none)'}; saved=${Object.keys(savedCustomization).join(',') || 'no recognized customization fields'}`, 200);
      res.json({ success: true, status: 1, code: 0, data: { profile: playerSaveDocument(await whitelistRepository.findBySteamId(player.steamId)), message: 'result saved' }, error: null });
    });
  } catch (error) {
    console.error('[End Game Result]', error.message);
    const invalid = /must be|invalid|too large|character ID|contains invalid/i.test(error.message);
    recordAdminLog(invalid ? 'warn' : 'error', 'Player Save', `End-game save failed: ${String(error.message || 'unknown error').slice(0, 180)}`, invalid ? 400 : 503);
    if (!res.headersSent) gameError(res, invalid ? 400 : 503, invalid ? error.message : 'Game result could not be saved');
  }
});
app.get('/live/bonus/api/get_bonus_data', async (_req, res) => {
  try {
    const item = await gameDataService.get('static/bonus/api/get_bonus_data.json');
    if (item?.data !== undefined) {
      return res.set('Cache-Control', 'no-store').json(item.data);
    }
    recordAdminLog('warn', 'Game API', 'Bonus endpoint has no synced static payload; returning an empty compatibility object', 200);
    return res.set('Cache-Control', 'no-store').json({ status: 1, data: {}, error: null });
  } catch (error) {
    console.error('[Bonus Data]', error.message);
    return gameError(res, 503, 'Bonus data could not be loaded');
  }
});
app.post('/live/exprk/api/table', async (_req, res) => {
  try {
    const item = await gameDataService.get('static/exprk/table.json');
    res.set('Cache-Control', 'no-store').json({ status: 1, data: item?.data ?? { table: [] }, error: null });
  } catch (error) { console.error('[EXPRK Table]', error.message); gameError(res, 503, 'EXPRK table data could not be loaded'); }
});
app.post('/logapi/v1/add/ingame', (req, res) => {
  const fields = listSafeGameFieldNames(req.body);
  recordAdminLog('info', 'Game Client', `Received in-game log event; fields=${fields.join(',') || '(none)'}`, 200);
  res.status(200).json({ status: 'success' });
});
app.post('/logapi/v1/add/matchlog', (req, res) => {
  // Match logs can arrive as one object or as a batch. Keep only short,
  // non-sensitive scalar values in the diagnostic log; never store tickets,
  // session credentials, or the full request body here.
  const sensitiveKey = /ticket|token|secret|api[_-]?key|authorization|steam[_-]?id|discord[_-]?id/i;
  const safeValue = value => String(value ?? '')
    .replace(/(ticket|session[_-]?token|access[_-]?token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b(?:[a-f0-9]{40,}|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 120);
  const entries = Array.isArray(req.body) ? req.body.slice(0, 20) : [req.body];
  let recorded = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const details = Object.entries(entry)
      .filter(([key, value]) => !sensitiveKey.test(key) && ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 8)
      .map(([key, value]) => `${safeValue(key)}=${safeValue(value)}`);
    const fields = Object.keys(entry).filter(key => !sensitiveKey.test(key)).slice(0, 16);
    recordAdminLog('info', 'Match Log', details.length
      ? details.join('; ')
      : `Received match log event; fields=${fields.join(',') || '(none)'}`, 200);
    recorded++;
  }
  if (!recorded) recordAdminLog('info', 'Match Log', 'Received match log payload with no safe scalar fields', 200);
  res.status(200).json({ status: 'success', recorded });
});
// Keep unknown game routes machine-readable and visible in Admin → System Logs.
app.use(['/live', '/logapi'], (req, res) => {
  const path = sanitizeGamePath(req.originalUrl.split('?')[0]);
  recordAdminLog('warn', 'Game API', `No handler registered for ${req.method} ${path}`, 404, identifyGameClient(req));
  gameError(res, 404, `Game API endpoint is not implemented: ${req.method} ${path}`);
});
app.use((err, req, res, next) => { console.error(err); res.status(400).json({ error: err.message || 'Request failed' }); });
const PLAYER_SAVE_SELECT = 'id,steam_id,discord_id,player_name,status,profile,coin,amethyst,amulet,character_slot,role,ban_status,player_record,sticker_slot,inventory,immortal_data,game_data,is_online,last_online,created_at,updated_at';
const PLAYER_SAVE_FIELDS = [
  ['profile','profile'],['coin','coin'],['amethyst','amethyst'],['amulet','amulet'],
  ['characterSlot','character_slot','character_slot'],['role','role'],['banStatus','ban_status','ban_status'],
  ['playerRecord','player_record','player_record'],['stickerSlot','sticker_slot','sticker_slot'],
  ['inventory','inventory'],['immortalData','immortal_data','immortal_data'],['isOnline','is_online','is_online'],['lastOnline','last_online','last_online']
];
const PLAYER_SAVE_PRIVATE_KEYS = new Set(['steamId','steam_id','_id','id','auth','session_token','sessionToken','player_name','discord_id','status','notes','createdAt','updatedAt','_exists']);
function playerSaveDocument(row) {
  const document = row.game_data && typeof row.game_data === 'object' && !Array.isArray(row.game_data) ? { ...row.game_data } : {};
  for (const key of PLAYER_SAVE_PRIVATE_KEYS) delete document[key];
  for (const [key, column, alias] of PLAYER_SAVE_FIELDS) {
    if (row[column] !== undefined) document[key] = row[column];
  }
  // The extracted Blueprint defines these members with GUID-suffixed keys
  // inside S_PlayerInfo. Rebuild missing exact keys from persisted clean aliases
  // so saves created by older server versions still deserialize in Unreal.
  const saveGame = document.PlayerSaveGame && typeof document.PlayerSaveGame === 'object' && !Array.isArray(document.PlayerSaveGame)
    ? document.PlayerSaveGame : null;
  if (saveGame) {
    const existingInfo = saveGame.S_PlayerInfo && typeof saveGame.S_PlayerInfo === 'object' && !Array.isArray(saveGame.S_PlayerInfo)
      ? saveGame.S_PlayerInfo : {};
    const info = { ...existingInfo };
    for (const [field, unrealKey] of Object.entries(PLAYER_SAVEGAME_UNREAL_FIELDS)) {
      if (info[unrealKey] === undefined && document[field] !== undefined) info[unrealKey] = document[field];
    }
    document.PlayerSaveGame = { ...saveGame, S_PlayerInfo: info };
  }
  return document;
}
function splitPlayerSave(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Save Data ต้องเป็น JSON object');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 900 * 1024) throw new Error('Save Data ใหญ่เกิน 900 KB');
  const gameData = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PLAYER_SAVE_PRIVATE_KEYS.has(key)) continue;
    const mapping = PLAYER_SAVE_FIELDS.find(([name, , alias]) => key === name || (alias && key === alias));
    if (!mapping) gameData[key] = entry;
  }
  const result = { game_data: gameData };
  for (const [key, column, alias] of PLAYER_SAVE_FIELDS) {
    const inputKey = Object.hasOwn(value, key) ? key : alias && Object.hasOwn(value, alias) ? alias : null;
    if (!inputKey) continue;
    let entry = value[inputKey];
    if (['coin','amethyst','amulet'].includes(key)) { entry = Number(entry); if (!Number.isFinite(entry)) throw new Error(`${key} ต้องเป็นตัวเลข`); }
    if (key === 'role' && typeof entry !== 'string') throw new Error('role ต้องเป็นข้อความ');
    if (key === 'profile' && (!entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('profile ต้องเป็น JSON object');
    if (key === 'isOnline') entry = entry === true || entry === 'true';
    result[column] = entry;
  }
  return result;
}
function cleanWhitelist(x = {}) { return { steam_id: String(x.steam_id || '').trim(), discord_id: String(x.discord_id || '').trim() || null, player_name: String(x.player_name || '').trim() || null, status: ['approved','pending','banned'].includes(x.status) ? x.status : 'pending', notes: String(x.notes || '').trim() || null, auth: x.auth || [], session_token: x.session_token || null, profile: x.profile || {}, coin: Number(x.coin) || 0, amethyst: Number(x.amethyst) || 0, amulet: Number(x.amulet) || 0, character_slot: x.character_slot ?? null, role: x.role || 'survivor', ban_status: x.ban_status ?? null, player_record: x.player_record ?? null, sticker_slot: x.sticker_slot ?? null, inventory: x.inventory ?? null, immortal_data: x.immortal_data || [], game_data: x.game_data && typeof x.game_data === 'object' ? x.game_data : {}, is_online: Boolean(x.is_online), last_online: x.last_online || null }; }
function compareLauncherVersions(a, b) { const parts = value => String(value).match(/^\d+\.\d+\.\d+/)[0].split('.').map(Number); const left = parts(a), right = parts(b); for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]; return 0; }
function cleanServer(x = {}) { return { room_name: String(x.room_name || '').trim(), host_ip: String(x.host_ip || '').trim(), port: Number(x.port) || 0, max_players: Number(x.max_players) || 0, is_online: Boolean(x.is_online), server_version: String(x.server_version || '').trim() || null, extra: x.extra && typeof x.extra === 'object' ? x.extra : {} }; }
function cleanRoomText(value, maxLength) { if (typeof value !== 'string') return ''; return value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength); }
function sendRoomError(res, error) {
  const message = String(error?.message || 'Room request failed');
  const conflict = error?.code === 'P0001';
  console.error('[lobbies]', error?.code || 'error', message);
  return res.status(conflict ? 409 : 500).json({ ok: false, error: conflict ? message : 'Room service request failed.' });
}
function readBoolean(value, fallback) { if (typeof value === 'boolean') return value; if (typeof value === 'string') { if (value.toLowerCase() === 'true') return true; if (value.toLowerCase() === 'false') return false; } return fallback; }
function gameError(res, statusCode, message) { return res.status(statusCode).json({ status: 0, data: null, error: message }); }
function normalizeGameFieldName(value) { return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function findGameAuthField(root, names, depth = 0) {
  if (depth > 4 || !root || typeof root !== 'object') return undefined;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findGameAuthField(item, names, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const wanted = new Set(names.map(normalizeGameFieldName));
  for (const [key, value] of Object.entries(root)) if (wanted.has(normalizeGameFieldName(key))) return value;
  for (const [key, value] of Object.entries(root)) {
    if (['data','auth','payload','request','player'].includes(normalizeGameFieldName(key))) {
      const found = findGameAuthField(value, names, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
function identifyGameClient(req) {
  const clean = value => String(value || '').replace(/[\r\n\t\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  const explicit = clean(req.get('x-game-name') || req.get('x-client-name') || req.get('x-game-client'));
  const userAgent = clean(req.get('user-agent'));
  return { name: 'Home Sweet Home Online', client: explicit || userAgent || 'client name not reported' };
}
function sanitizeGamePath(value) {
  return String(value || '')
    .replace(/\d{17,}/g, '[numeric-id]')
    .replace(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?/g, '[redacted-token]')
    .slice(0, 240);
}
function diagnoseGameHttpResult(status, responseShape = []) {
  if (status === 400) return 'ตรวจ Content-Type และฟิลด์ที่ request ส่งมา; server ปฏิเสธรูปแบบหรือข้อมูล';
  if (status === 401 || status === 403) return 'ตรวจ Steam ticket/session, whitelist และสิทธิ์ของผู้เล่น';
  if (status === 404) return 'ไม่มี handler สำหรับ method/path นี้ หรือ route ไม่ตรง';
  if (status === 405) return 'ตรวจ HTTP method ที่เกมเรียกกับ method ที่ route รองรับ';
  if (status === 413) return 'request ใหญ่เกินขีดจำกัด body ของ server';
  if (status === 429) return 'ถูกจำกัดจำนวน request; ตรวจ rate limit/retry';
  if (status >= 500) return 'เกิดข้อผิดพลาดฝั่ง server; ตรวจ Render application logs/Supabase error';
  if (status >= 200 && status < 300 && !responseShape.length) return 'HTTP ผ่าน แต่ไม่พบ JSON response shape ให้ตรวจว่า endpoint ตอบ body กลับหรือไม่';
  return '';
}
function describeGamePayloadShape(root, maxItems = 24) {
  const result = [];
  const sensitive = /ticket|token|secret|api[_-]?key|authorization|steam[_-]?id|discord[_-]?id|password/i;
  const visit = (value, prefix = '', depth = 0) => {
    if (result.length >= maxItems || depth > 4) return;
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      result.push(`${prefix || 'body'}:array[${value.length}]`);
      if (depth < 2 && value.length && value[0] && typeof value[0] === 'object') visit(value[0], `${prefix || 'body'}[]`, depth + 1);
      return;
    }
    for (const [rawKey, child] of Object.entries(value)) {
      if (result.length >= maxItems) break;
      const key = String(rawKey).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
      if (!key) continue;
      const field = prefix ? `${prefix}.${key}` : key;
      if (sensitive.test(key)) { result.push(`${field}:[present; value hidden]`); continue; }
      if (child === null) result.push(`${field}:null`);
      else if (Array.isArray(child)) {
        result.push(`${field}:array[${child.length}]`);
        if (depth < 2 && child.length && child[0] && typeof child[0] === 'object') visit(child[0], `${field}[]`, depth + 1);
      } else if (typeof child === 'object') {
        result.push(`${field}:object`);
        visit(child, field, depth + 1);
      } else result.push(`${field}:${typeof child}`);
    }
  };
  visit(root);
  return result;
}
function listSafeGameFieldNames(root, depth = 0) {
  if (depth > 4 || !root || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(item => listSafeGameFieldNames(item, depth + 1)).slice(0, 30);
  const names = [];
  for (const [key, value] of Object.entries(root)) {
    const safeKey = String(key).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
    if (safeKey && !/ticket|token|secret|key|authorization/i.test(safeKey)) names.push(safeKey);
    if (value && typeof value === 'object') names.push(...listSafeGameFieldNames(value, depth + 1));
  }
  return [...new Set(names)].slice(0, 30);
}
function isBanActive(ban) { if (!ban || typeof ban !== 'object') return false; return !!ban.permanentBanned || !!(ban.bannedUntil && new Date(ban.bannedUntil) > new Date()); }
function issueGameSessionToken(steamId) {
  const secret = String(process.env.GAME_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('GAME_SESSION_SECRET is not configured');
  const b64 = value => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ steamId, type: 'session', iat: now, exp: now + 86400 }))}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
function verifyGameSessionToken(token) {
  const secret = String(process.env.GAME_SESSION_SECRET || '').trim();
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(unsigned).digest('base64url'));
  const actual = Buffer.from(parts[2]);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || claims.type !== 'session' || !/^\d{17}$/.test(String(claims.steamId || '')) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) return null;
    return String(claims.steamId);
  } catch { return null; }
}
function toLegacyInventory(inventory, fallback) {
  if (!inventory || typeof inventory !== 'object') return fallback;
  if (inventory.inventory && typeof inventory.inventory === 'object') return inventory;
  const converted = { inventory: {} };
  for (const key of ['characters','skins','perks','profiles','stickers','heads','backs','costumes','rituals','cosmeticconsume','bundles','poses','effects']) {
    for (const item of Array.isArray(inventory[key]) ? inventory[key] : []) if (item && item !== 'None') converted.inventory[item] = 1;
  }
  if (Array.isArray(inventory.items) && Array.isArray(inventory.itemCounts)) inventory.items.forEach((item, index) => { if (item) converted.inventory[item] = inventory.itemCounts[index] || 1; });
  return converted;
}
function safeName(value) { const name = String(value || '').trim(); if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/.test(name)) throw new Error('ใช้ชื่อ 2-40 ตัวอักษร เริ่มด้วย a-z และใช้ได้เฉพาะตัวเลข _ -'); return name; }
function signLauncherClient(clientId) { return crypto.createHmac('sha256', LAUNCHER_TOKEN).update(`launcher-client-v1:${clientId}`).digest('hex'); }
function verifyLauncherClient(clientId, authorization) { if (!LAUNCHER_TOKEN || !authorization?.startsWith('Bearer ')) return false; const supplied = Buffer.from(authorization.slice(7), 'hex'); const expected = Buffer.from(signLauncherClient(clientId), 'hex'); return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected); }
async function fetchAllRows(buildQuery, pageSize = 1000) { const rows = []; for (let offset = 0; ; offset += pageSize) { const { data, error } = await buildQuery().range(offset, offset + pageSize - 1); if (error) throw error; rows.push(...data); if (data.length < pageSize) return rows; } }
async function coreCollectionId(name) { const { data: dbRow, error: dbError } = await supabase.from('admin_databases').select('id').eq('name','HSHO-PrivateServer').single(); if (dbError) throw dbError; const { data: row, error } = await supabase.from('admin_collections').select('id').eq('database_id',dbRow.id).eq('name',name).single(); if (error) throw error; return row.id; }
const port = Number(process.env.PORT) || 3000;
const GAME_BOOTSTRAP_STATIC_FILES = [
  'static/player/PlayerTemplate.json',
  'static/player/immortal.json',
  'static/player/curserelic.json',
  'static/store/P_List.json',
  'static/store/I_List.json',
  'static/store/S_List.json',
  'static/store/taglist/C_Survivor.json',
  'static/store/taglist/P_Survivor.json',
  'static/store/taglist/Effect_Hunter.json',
  'static/store/taglist/P_Hunter.json',
  'static/store/taglist/C_Hunter.json',
  'static/inventory/Characters.json',
  'static/inventory/Skins.json',
  'static/inventory/Perks.json',
  'static/inventory/Profile.json',
  'static/inventory/Stickers.json',
  'static/inventory/Heads.json',
  'static/inventory/Backs.json',
  'static/inventory/Bundles.json',
  'static/inventory/Poses.json',
  'static/inventory/SummonEffect.json',
  'static/inventory/Rituals.json',
  'static/inventory/Items.json',
  'static/inventory/K_Cosmetic.json',
  'static/inventory/S_Cosmetic.json',
  'static/pots/greedy.json',
  'static/pots/bullet.json',
  'static/bonus/api/get_bonus_data.json',
  'static/exprk/table.json',
];

async function startServer() {
  if (gameDataService) {
    try {
      const warmResult = await Promise.race([
        gameDataService.warm(GAME_BOOTSTRAP_STATIC_FILES),
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 8000)),
      ]);
      if (warmResult.timedOut) {
        recordAdminLog('warn', 'Game Data', 'Static data prewarm exceeded 8 seconds; game routes will warm files on demand');
      } else {
        recordAdminLog('info', 'Game Data', `Preloaded ${warmResult.warmed} static files in one query; missing=${warmResult.missing.length}`, 200);
      }
    } catch (error) {
      recordAdminLog('warn', 'Game Data', `Static data prewarm failed; routes will warm files on demand: ${error.message}`);
    }
  }
  app.listen(port, () => console.log(`HSH admin listening on ${port}`));
}
startServer();
async function sendDiscordApprovalDM(discordId) {
  const baseUrl = String(process.env.DISCORD_BOT_API_URL || '').trim().replace(/\/+$/, '');
  const secret = process.env.DISCORD_BOT_WEBHOOK_SECRET || '';
  if (!baseUrl || !secret) throw new Error('Discord bot service URL/secret is not configured on the web service');
  const response = await fetch(`${baseUrl}/internal/approved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ discord_id: discordId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Discord bot service returned ${response.status}`);
  return result;
}


