'use strict';

let client = null;
const DIRECT_FIELDS = new Set(['steamId','auth','session_token','profile','coin','amethyst','amulet','characterSlot','role','banStatus','playerRecord','stickerSlot','inventory','immortalData','isOnline','lastOnline','player_name','discord_id','status','notes','save_data','save_updated_at','save_source','_saveDataWrite']);

function fromRow(row) {
  const extra = row.game_data && typeof row.game_data === 'object' ? row.game_data : {};
  const saved = row.save_data && typeof row.save_data === 'object' && !Array.isArray(row.save_data) ? row.save_data : {};
  const player = Object.assign(new Player(), extra, saved, {
    steamId: row.steam_id,
    auth: row.auth || extra.auth || [],
    session_token: row.session_token || null,
    profile: row.profile || extra.profile || {},
    coin: Number(row.coin ?? extra.coin ?? 0),
    amethyst: Number(row.amethyst ?? extra.amethyst ?? 0),
    amulet: Number(row.amulet ?? extra.amulet ?? 0),
    characterSlot: row.character_slot ?? extra.characterSlot ?? null,
    role: row.role || extra.role || 'survivor',
    banStatus: row.ban_status ?? extra.banStatus ?? null,
    playerRecord: row.player_record ?? extra.playerRecord ?? null,
    stickerSlot: row.sticker_slot ?? extra.stickerSlot ?? null,
    inventory: row.inventory ?? extra.inventory ?? null,
    immortalData: row.immortal_data ?? extra.immortalData ?? [],
    isOnline: Boolean(row.is_online),
    lastOnline: row.last_online || extra.lastOnline || null,
    save_data: saved,
    save_updated_at: row.save_updated_at || null,
    // A non-empty snapshot can be a template/admin seed. Only trust the
    // explicit source column; legacy rows without metadata are unknown.
    save_source: row.save_source || 'unknown',
    _id: row.steam_id,
    id: row.id,
    status: row.status,
    player_name: row.player_name,
    discord_id: row.discord_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    _exists: true
  });
  return player;
}

function toGameData(player) {
  const extra = {};
  for (const [key, value] of Object.entries(player)) if (!DIRECT_FIELDS.has(key) && !['_id','id','createdAt','updatedAt','_exists'].includes(key)) extra[key] = value;
  return extra;
}

class Player {
  constructor(values = {}) {
    Object.assign(this, {
      auth: [], session_token: null, profile: { display: 'Profile_Default', displayName: '', lastNameUpdate: null },
      coin: 0, amethyst: 0, amulet: 0, role: 'survivor', immortalData: [], isOnline: false,
      ...values
    });
    this._exists = false;
  }

  // Keep the Mongoose-style service API compatible; Supabase saves the full
  // JSON payload, so fields do not need per-property dirty tracking.
  markModified() {}

  static configure(supabase) { client = supabase; }
  static assertReady() { if (!client) throw new Error('Supabase Player repository is not configured'); }

  static async findOne(filter = {}) {
    this.assertReady();
    let query = client.from('whitelists').select('*');
    if (filter.steamId || filter.steam_id) query = query.eq('steam_id', filter.steamId || filter.steam_id);
    else if (filter._id) query = query.eq('id', filter._id);
    else if (filter['auth.extId']) query = query.contains('auth', [{ extId: filter['auth.extId'] }]);
    else throw new Error('Unsupported player lookup filter');
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? fromRow(data) : null;
  }

  static async findById(id) {
    this.assertReady();
    const value = String(id || '');
    const query = /^[0-9a-f-]{36}$/i.test(value)
      ? client.from('whitelists').select('*').eq('id', value).maybeSingle()
      : client.from('whitelists').select('*').eq('steam_id', value).maybeSingle();
    const { data, error } = await query;
    if (error) throw error;
    return data ? fromRow(data) : null;
  }

  static async findOneAndUpdate(filter, changes) {
    this.assertReady();
    const player = await this.findOne(filter);
    if (!player) return null;
    Object.assign(player, changes);
    return player.save();
  }

  async save() {
    Player.assertReady();
    const steamId = String(this.steamId || '').trim();
    if (!/^\d{17}$/.test(steamId)) throw new Error('A valid SteamID64 is required for player storage');
    const record = {
      steam_id: steamId,
      auth: this.auth || [],
      session_token: this.session_token || null,
      profile: this.profile || {},
      coin: Number(this.coin) || 0,
      amethyst: Number(this.amethyst) || 0,
      amulet: Number(this.amulet) || 0,
      character_slot: this.characterSlot ?? null,
      role: this.role || 'survivor',
      ban_status: this.banStatus ?? null,
      player_record: this.playerRecord ?? null,
      sticker_slot: this.stickerSlot ?? null,
      inventory: this.inventory ?? null,
      immortal_data: this.immortalData || [],
      is_online: Boolean(this.isOnline),
      last_online: this.lastOnline instanceof Date ? this.lastOnline.toISOString() : (this.lastOnline || null),
      game_data: toGameData(this),
      // Include the current values on upsert so login/session writes preserve
      // an earlier game save while leaving its timestamp and provenance alone.
      save_data: this.save_data && typeof this.save_data === 'object' && !Array.isArray(this.save_data) ? this.save_data : {},
      save_updated_at: this.save_updated_at || null,
      save_source: ['game','admin','template','server','unknown'].includes(this.save_source) ? this.save_source : 'template',
      updated_at: new Date().toISOString()
    };
    // Ordinary saves (login/session/online state) must never manufacture or
    // overwrite a game Save Data snapshot. Game/admin save handlers opt in.
    if (this._saveDataWrite === true) {
      record.save_data = buildSaveSnapshot(this);
      record.save_updated_at = new Date().toISOString();
      record.save_source = ['game','admin'].includes(this.save_source) ? this.save_source : 'game';
    }
    if (this.player_name) record.player_name = this.player_name;
    if (this.discord_id) record.discord_id = this.discord_id;
    const { data, error } = await client.from('whitelists').upsert(record, { onConflict: 'steam_id' }).select('*').single();
    if (error) throw error;
    this._saveDataWrite = false;
    Object.assign(this, fromRow(data));
    return this;
  }
}

function buildSaveSnapshot(player) {
  const extras = toGameData(player);
  const prior = player.save_data && typeof player.save_data === 'object' && !Array.isArray(player.save_data)
    ? player.save_data : {};
  return {
    ...prior,
    ...extras,
    profile: player.profile || {},
    coin: Number(player.coin) || 0,
    amethyst: Number(player.amethyst) || 0,
    amulet: Number(player.amulet) || 0,
    characterSlot: player.characterSlot ?? null,
    role: player.role || 'survivor',
    playerRecord: player.playerRecord ?? null,
    stickerSlot: player.stickerSlot ?? null,
    inventory: player.inventory ?? null,
    immortalData: player.immortalData || []
  };
}

module.exports = Player;
