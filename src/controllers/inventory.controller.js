const inventoryService = require('@services/inventory.service');
const playerDataService = require('@services/player-data.service');
const { sendError, sendSuccess } = require('@utils/response.util');

function getAuthenticatedPlayer(req, res) {
  if (!req.player) {
    sendError(res, 401, 'Unauthorized - Invalid session');
    return null;
  }

  return req.player;
}

function getErrorStatusCode(message = '') {
  if (
    message.includes('not owned') ||
    message.includes('not found') ||
    message.includes('Invalid') ||
    message.includes('must contain') ||
    message.includes('required')
  ) {
    return 400;
  }

  return 500;
}

// Preserve the actual game mutation payload alongside the canonical player
// columns. This makes fields whose Unreal property names vary by build
// inspectable in Save Data, while excluding credentials and client-owned
// economy/inventory values from this diagnostic snapshot.
const PRIVATE_OR_SERVER_OWNED_KEY = /(?:session|token|ticket|secret|steam.?id|discord.?id|currency|coin|cash|gold|amulet|amethyst|money|balance|inventory|itemcount|banstatus|auth)/i;
function sanitizeGameMutation(value, depth = 0, state = { entries: 0 }) {
  if (depth > 12 || ++state.entries > 5000) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 20000 ? value.slice(0, 20000) : value;
  if (Array.isArray(value)) {
    return value.slice(0, 1000).map(item => sanitizeGameMutation(item, depth + 1, state)).filter(item => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, nested] of Object.entries(value).slice(0, 1000)) {
    if (PRIVATE_OR_SERVER_OWNED_KEY.test(key)) continue;
    const clean = sanitizeGameMutation(nested, depth + 1, state);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

function recordGameMutation(player, req, body) {
  const sanitized = sanitizeGameMutation(body);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized) || !Object.keys(sanitized).length) return false;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') > 500 * 1024) {
    const error = new Error('Game save payload is too large (max 500 KB)');
    error.statusCode = 413;
    throw error;
  }
  const existing = player.save_data && typeof player.save_data === 'object' && !Array.isArray(player.save_data)
    ? player.save_data : {};
  player.save_data = {
    ...existing,
    last_game_mutation: {
      endpoint: req.path,
      received_at: new Date().toISOString(),
      fields: Object.keys(sanitized),
      data: sanitized,
    },
  };
  player.save_source = 'game';
  player._saveDataWrite = true;
  return true;
}

exports.getInventoryAll = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    // This endpoint is the fresh snapshot the game applies after auth. Seed
    // legacy zero balances here too, so that snapshot cannot replace 6,000
    // shown by auth with stale zeros from an older Supabase row.
    if (playerDataService.seedInitialCurrencies(player)) await player.save();

    return sendSuccess(res, inventoryService.getInventoryState(player));
  } catch (error) {
    console.error('getInventoryAll error:', error);
    return sendError(res, 500, error.message || 'Server error');
  }
};

exports.getCharacterSlot = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    const slots = inventoryService.getCharacterSlotData(player);

    if (!slots) {
      return sendError(res, 404, 'Character slot not found');
    }

    return sendSuccess(res, {
      session_token: player.session_token,
      slots,
      role: player.role,
    });
  } catch (error) {
    console.error('getCharacterSlot error:', error);
    return sendError(res, 500, error.message || 'Server error');
  }
};

exports.editCharacterSlot = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mutationRecorded = recordGameMutation(player, req, body);
    const normalize = value => String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const findField = (source, aliases) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
      const wanted = new Set(aliases.map(normalize));
      const key = Object.keys(source).find(candidate => {
        const actual = normalize(candidate);
        return wanted.has(actual) || [...wanted].some(base => new RegExp(`^${base}\\d+[a-f0-9]{32}$`, 'i').test(actual));
      });
      return key === undefined ? undefined : source[key];
    };
    // Runtime payloads may wrap the struct in data/playerInfo/Properties and
    // Unreal builds append a field index plus GUID to property names.
    const sources = [];
    const seen = new Set();
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8 || seen.has(value)) return;
      seen.add(value);
      sources.push(value);
      for (const [key, nested] of Object.entries(value)) {
        if (['data','payload','playerdata','playerinfo','splayerinfo','playersavegame','properties','characterSlot','character_slot','slots'].includes(normalize(key))) visit(nested, depth + 1);
      }
    };
    visit(body);
    const fromSources = aliases => {
      for (const source of sources) {
        const value = findField(source, aliases);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const slotsValue = fromSources(['slots','characterSlot','character_slot']);
    const slots = slotsValue && typeof slotsValue === 'object' && !Array.isArray(slotsValue) ? slotsValue : body;
    const normalizedSlots = {};
    const slotAliases = [
      ['hunterSlot', ['hunterSlot','HunterSlots']],
      ['survivorSlot', ['survivorSlot','SurvivorSlots']],
      ['characterhunteritem', ['characterhunteritem','CharacterHunterItem']],
      ['characteritem', ['characteritem','CharacterItem']],
    ];
    for (const [canonical, aliases] of slotAliases) {
      const value = findField(slots, aliases) ?? fromSources(aliases);
      if (value !== undefined) normalizedSlots[canonical] = value;
    }
    const singleCharacterId = findField(slots, ['character']) ?? fromSources(['character']);
    if (singleCharacterId !== undefined) {
      const character = String(singleCharacterId);
      const collection = character.startsWith('Hunter_') ? 'hunterSlot'
        : character.startsWith('Survivor_') ? 'survivorSlot' : null;
      if (!collection) return sendError(res, 400, 'Character slot payload has an unknown character ID');
      if (!normalizedSlots[collection]) normalizedSlots[collection] = [slots];
    }
    const role = fromSources(['role','playerRole']);

    // Retain the exact Unreal property names (including GUID suffixes) in the
    // same Steam player's Save Data. The canonical slot columns remain usable
    // by the game's existing GET endpoint.
    const unrealAliases = ['DefaultCharacter','CharacterItem','CharacterHunterItem','StickerPreset','SurvivorSlots','HunterSlots','StickerAssets','FrameImage','PlayerCharacterInfo','CurseSlots','RelicSlots'];
    const unrealInfo = {};
    for (const source of sources) {
      for (const [key, value] of Object.entries(source)) {
        const actual = normalize(key);
        const allowed = unrealAliases.some(alias => {
          const base = normalize(alias);
          return actual === base || new RegExp(`^${base}\\d+[a-f0-9]{32}$`, 'i').test(actual);
        });
        if (!allowed) continue;
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized, 'utf8') > 200 * 1024) return sendError(res, 413, `${key} is too large`);
        unrealInfo[key] = JSON.parse(serialized);
      }
    }
    const hasSlotChanges = Object.keys(normalizedSlots).length > 0;
    if (!hasSlotChanges && !Object.keys(unrealInfo).length) {
      if (!mutationRecorded) return sendError(res, 400, 'Character slot payload has no saveable fields');
      // Keep an authenticated, sanitized payload for diagnosis and future
      // schema mapping; do not pretend the server understood its outfit fields.
      await player.save();
      return sendSuccess(res, {
        session_token: player.session_token,
        slots: inventoryService.getCharacterSlotData(player),
        role: player.role,
      });
    }
    if (Object.keys(unrealInfo).length) {
      const previous = player.PlayerSaveGame && typeof player.PlayerSaveGame === 'object' && !Array.isArray(player.PlayerSaveGame)
        ? player.PlayerSaveGame : {};
      const previousInfo = previous.S_PlayerInfo && typeof previous.S_PlayerInfo === 'object' && !Array.isArray(previous.S_PlayerInfo)
        ? previous.S_PlayerInfo : {};
      player.PlayerSaveGame = { ...previous, ...unrealInfo, S_PlayerInfo: { ...previousInfo, ...unrealInfo } };
      for (const alias of unrealAliases) {
        const key = Object.keys(unrealInfo).find(candidate => normalize(candidate) === normalize(alias) || new RegExp(`^${normalize(alias)}\\d+[a-f0-9]{32}$`, 'i').test(normalize(candidate)));
        if (key) player[alias] = unrealInfo[key];
      }
      player.save_source = 'game';
      player._saveDataWrite = true;
    }
    const result = hasSlotChanges
      ? await inventoryService.updateCharacterSlot(player, normalizedSlots, role)
      : (await player.save(), { slots: inventoryService.getCharacterSlotData(player), role: player.role });

    return sendSuccess(res, {
      session_token: player.session_token,
      ...result,
    });
  } catch (error) {
    console.error('editCharacterSlot error:', error);
    return sendError(res, error.statusCode || getErrorStatusCode(error.message), error.message || 'Server error');
  }
};

exports.editProfile = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    if (!req.body.profile) {
      return sendError(res, 400, 'Profile is required');
    }

    recordGameMutation(player, req, req.body);

    const updatedProfile = await inventoryService.updatePlayerProfile(player, req.body.profile);

    return sendSuccess(res, {
      profile: updatedProfile,
      session_token: player.session_token,
    });
  } catch (error) {
    console.error('Profile edit error:', error);
    return sendError(res, error.statusCode || getErrorStatusCode(error.message), error.message || 'Internal server error');
  }
};

exports.editSticker = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    if (!req.body.stickerInfo) {
      return sendError(res, 400, 'Sticker info is required');
    }

    recordGameMutation(player, req, req.body);

    const updatedStickers = await inventoryService.updatePlayerStickers(
      player,
      req.body.stickerInfo
    );

    return sendSuccess(res, {
      stickerSlot: updatedStickers,
      session_token: player.session_token,
    });
  } catch (error) {
    console.error('Sticker edit error:', error);
    return sendError(res, error.statusCode || getErrorStatusCode(error.message), error.message || 'Internal server error');
  }
};

exports.addItem = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    const { itemId, quantity = 1 } = req.body;

    if (!itemId) {
      return sendError(res, 400, 'itemId is required');
    }

    const result = await inventoryService.addItemToInventory(player, itemId, quantity);

    return sendSuccess(res, {
      ...result,
      session_token: player.session_token,
    });
  } catch (error) {
    console.error('Add item error:', error);
    return sendError(res, 500, error.message || 'Internal server error');
  }
};

exports.removeItem = async (req, res) => {
  try {
    const player = getAuthenticatedPlayer(req, res);

    if (!player) {
      return null;
    }

    if (!req.body.itemId) {
      return sendError(res, 400, 'itemId is required');
    }

    const result = await inventoryService.removeItemFromInventory(player, req.body.itemId);

    return sendSuccess(res, {
      ...result,
      session_token: player.session_token,
    });
  } catch (error) {
    console.error('Remove item error:', error);
    return sendError(res, 500, error.message || 'Internal server error');
  }
};
