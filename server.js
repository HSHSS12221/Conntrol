require('module-alias/register');
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const authTemplate = require('./templates/auth.json');
const { createClient } = require('@supabase/supabase-js');
const { createGameDataService } = require('./src/services/game-data.service');
const { createWhitelistRepository } = require('./src/repositories/whitelist.repository');
const PlayerModel = require('./src/models/player.model');
const ServerInfoModel = require('./src/models/server.model');
const staticJsonUtil = require('./src/utils/static-json.util');
const gameHealthRoutes = require('./src/Health');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const adminLogs = [];
function recordAdminLog(level, source, message, status = null) {
  adminLogs.unshift({ at: new Date().toISOString(), level, source, message: String(message).slice(0, 240), status });
  if (adminLogs.length > 300) adminLogs.length = 300;
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN, LAUNCHER_TOKEN } = process.env;
function publicBaseUrl(req) { return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, ''); }
function publishedServerInfoUrl(req) { return `${publicBaseUrl(req)}/public/servers`; }
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
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
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Set ADMIN_TOKEN on the server.' });
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
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
    const base = publicBaseUrl(req);
    const players = playerRows.map(({ auth, session_token, notes, ...player }) => player);
    res.set('Cache-Control', 'no-store').json({
      updated_at: new Date().toISOString(),
      host: base,
      urls: { serverinfo: publishedServerInfoUrl(req), whitelist: `${base}/public/whitelist` },
      serverinfo: serverRows.map(row => row.data),
      players
    });
  } catch (e) { next(e); }
});
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/game-data', async (_req, res, next) => { try { res.set('Cache-Control', 'no-store').json(await gameDataService.list()); } catch (e) { next(e); } });
app.get('/api/game-data/file', async (req, res) => { try { const item = await gameDataService.get(req.query.path); if (!item) return res.status(404).json({ error: 'Game data file has not been synced to Supabase' }); res.set('Cache-Control', 'no-store').json(item); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/game-data/sync', async (_req, res, next) => { try { const result = await gameDataService.syncFromRepository(); recordAdminLog('info', 'Game Data', `Synced ${result.synced} JSON files to Supabase`, 200); res.json(result); } catch (e) { recordAdminLog('error', 'Game Data', e.message, 500); next(e); } });
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
app.post('/live/player/authen', async (req, res) => {
  recordAdminLog('info', 'Steam Auth', 'Received POST /live/player/authen');
  try {
    if (String(req.body?.authType || '').toLowerCase() !== 'steam') { recordAdminLog('warn', 'Steam Auth', 'Rejected request: authType is not steam', 400); return gameError(res, 400, 'Only Steam authentication is supported'); }
    const ticket = String(req.body?.ticket || '').trim();
    if (!/^(?:[a-f0-9]{2}){20,8192}$/i.test(ticket)) { recordAdminLog('warn', 'Steam Auth', 'Rejected request: Steam ticket missing or malformed', 400); return gameError(res, 400, 'A valid Steam session ticket is required'); }

    const publisherKey = String(process.env.STEAM_PUBLISHER_KEY || '').trim();
    const appId = String(process.env.STEAM_APP_ID || '480').trim();
    if (!publisherKey || !/^\d+$/.test(appId)) { recordAdminLog('error', 'Steam Auth', 'Steam ticket validation environment is incomplete', 503); return gameError(res, 503, 'Steam ticket validation is not configured'); }
    const steamUrl = new URL('https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/');
    steamUrl.searchParams.set('key', publisherKey);
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
    if (!/^\d{17}$/.test(steamId)) { recordAdminLog('warn', 'Steam Auth', 'Steam response did not contain a valid SteamID; ticket rejected', 401); return gameError(res, 401, 'Steam rejected the session ticket'); }

    const row = await whitelistRepository.findBySteamId(steamId);
    if (!row) { recordAdminLog('warn', 'Steam Auth', 'Authenticated SteamID is absent from whitelist', 403); return gameError(res, 403, 'Steam account is not on the whitelist'); }
    if (row.status === 'banned' || isBanActive(row.ban_status)) { recordAdminLog('warn', 'Steam Auth', 'Whitelist rejected: player is banned', 403); return gameError(res, 403, 'Your account has been banned'); }
    if (row.status !== 'approved') { recordAdminLog('warn', 'Steam Auth', `Whitelist rejected: status is ${row.status}`, 403); return gameError(res, 403, 'Your whitelist is not approved'); }

    // Load ServerInfo before updating session state so configuration failures
    // are reported clearly and do not leave a half-created login session.
    const { serverInfo } = await readGameServerInfo();
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
    player.characterSlot = saved.character_slot || player.characterSlot;
    player.role = saved.role || player.role;
    player.stickerSlot = saved.sticker_slot || player.stickerSlot;
    player.inventory = toLegacyInventory(saved.inventory, player.inventory);
    player.coin = saved.coin ?? player.coin;
    player.amethyst = saved.amethyst ?? player.amethyst;
    player.amulet = saved.amulet ?? player.amulet;
    player.banStatus = saved.ban_status || player.banStatus;
    player.playerRecord = saved.player_record || player.playerRecord;
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
});
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
  const base = publicBaseUrl(req);
  let discord_verify_url = '';
  const botUrl = String(process.env.DISCORD_BOT_API_URL || '').trim().replace(/\/+$/, '');
  if (botUrl) {
    try { const response = await fetch(`${botUrl}/public/verify-link`); if (response.ok) discord_verify_url = (await response.json()).url || ''; }
    catch (error) { console.warn('[Discord] Could not load verify link:', error.message); }
  }
  const verifyServiceUrl = String(process.env.LAUNCHER_VERIFY_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  res.set('Cache-Control','no-store').json({ host: base, serverinfo_url: publishedServerInfoUrl(req), game_data_url: `${base}/public/game-data`, auth_url: `${base}/live/player/authen`, game_api_url: `${base}/live/player/gameplay/checkversion`, whitelist_url: `${base}/public/whitelist`, discord_verify_url, discord_login_url: verifyServiceUrl ? `${verifyServiceUrl}/oauth/launcher` : '' });
});
app.use('/', gameHealthRoutes);
// The game API adapters in src use Supabase repositories and static JSON rows.
// Existing auth/checkversion handlers above take precedence; remaining routes
// are served by the adapted game API router.
app.use('/', require('./src/routes/index'));
app.use((err, req, res, next) => { console.error(err); res.status(400).json({ error: err.message || 'Request failed' }); });
function cleanWhitelist(x = {}) { return { steam_id: String(x.steam_id || '').trim(), discord_id: String(x.discord_id || '').trim() || null, player_name: String(x.player_name || '').trim() || null, status: ['approved','pending','banned'].includes(x.status) ? x.status : 'pending', notes: String(x.notes || '').trim() || null, auth: x.auth || [], session_token: x.session_token || null, profile: x.profile || {}, coin: Number(x.coin) || 0, amethyst: Number(x.amethyst) || 0, amulet: Number(x.amulet) || 0, character_slot: x.character_slot ?? null, role: x.role || 'survivor', ban_status: x.ban_status ?? null, player_record: x.player_record ?? null, sticker_slot: x.sticker_slot ?? null, inventory: x.inventory ?? null, immortal_data: x.immortal_data || [], game_data: x.game_data && typeof x.game_data === 'object' ? x.game_data : {}, is_online: Boolean(x.is_online), last_online: x.last_online || null }; }
function cleanServer(x = {}) { return { room_name: String(x.room_name || '').trim(), host_ip: String(x.host_ip || '').trim(), port: Number(x.port) || 0, max_players: Number(x.max_players) || 0, is_online: Boolean(x.is_online), server_version: String(x.server_version || '').trim() || null, extra: x.extra && typeof x.extra === 'object' ? x.extra : {} }; }
function readBoolean(value, fallback) { if (typeof value === 'boolean') return value; if (typeof value === 'string') { if (value.toLowerCase() === 'true') return true; if (value.toLowerCase() === 'false') return false; } return fallback; }
function gameError(res, statusCode, message) { return res.status(statusCode).json({ status: 0, data: null, error: message }); }
function isBanActive(ban) { if (!ban || typeof ban !== 'object') return false; return !!ban.permanentBanned || !!(ban.bannedUntil && new Date(ban.bannedUntil) > new Date()); }
function issueGameSessionToken(steamId) {
  const secret = String(process.env.GAME_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('GAME_SESSION_SECRET is not configured');
  const b64 = value => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ steamId, type: 'session', iat: now, exp: now + 86400 }))}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
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
app.listen(port, () => console.log(`HSH admin listening on ${port}`));
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
