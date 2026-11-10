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
    const getField = (source, aliases) => {
      const wanted = new Set(aliases.map(key => key.replace(/[^a-z0-9]/gi, '').toLowerCase()));
      const found = Object.keys(source).find(key => wanted.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()));
      return found === undefined ? undefined : source[found];
    };
    const nestedValue = getField(body, ['data']);
    const nested = nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue) ? nestedValue : {};
    const directSlots = ['hunterSlot','survivorSlot','characterhunteritem','characteritem']
      .some(key => getField(body, [key]) !== undefined)
      || getField(body, ['character']) !== undefined;
    const slots = getField(body, ['slots','characterSlot','character_slot'])
      ?? getField(nested, ['slots','characterSlot','character_slot'])
      ?? (directSlots ? body : null);
    const role = getField(body, ['role']) ?? getField(nested, ['role']);
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
      return sendError(res, 400, 'Character slot data is missing (expected slots or characterSlot)');
    }
    const hasSlotFields = ['hunterSlot','survivorSlot','characterhunteritem','characteritem','character']
      .some(key => getField(slots, [key]) !== undefined);
    if (!hasSlotFields) {
      return sendError(res, 400, 'Character slot payload has no editable slot fields');
    }
    const normalizedSlots = {};
    for (const key of ['hunterSlot','survivorSlot','characterhunteritem','characteritem']) {
      const value = getField(slots, [key]);
      if (value !== undefined) normalizedSlots[key] = value;
    }
    const singleCharacterId = getField(slots, ['character']);
    if (singleCharacterId !== undefined) {
      const character = String(singleCharacterId);
      const collection = character.startsWith('Hunter_') ? 'hunterSlot'
        : character.startsWith('Survivor_') ? 'survivorSlot' : null;
      if (!collection) return sendError(res, 400, 'Character slot payload has an unknown character ID');
      if (!normalizedSlots[collection]) normalizedSlots[collection] = [slots];
    }
    const result = await inventoryService.updateCharacterSlot(player, normalizedSlots, role);

    return sendSuccess(res, {
      session_token: player.session_token,
      ...result,
    });
  } catch (error) {
    console.error('editCharacterSlot error:', error);
    return sendError(res, getErrorStatusCode(error.message), error.message || 'Server error');
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

    const updatedProfile = await inventoryService.updatePlayerProfile(player, req.body.profile);

    return sendSuccess(res, {
      profile: updatedProfile,
      session_token: player.session_token,
    });
  } catch (error) {
    console.error('Profile edit error:', error);
    return sendError(res, getErrorStatusCode(error.message), error.message || 'Internal server error');
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
    return sendError(res, getErrorStatusCode(error.message), error.message || 'Internal server error');
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
