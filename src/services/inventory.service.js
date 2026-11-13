const OWNERSHIP_CATEGORIES = [
  'characters',
  'skins',
  'perks',
  'profiles',
  'stickers',
  'heads',
  'backs',
  'costumes',
  'rituals',
  'cosmeticconsume',
  'bundles',
  'poses',
  'effects',
  'items',
];

const CHARACTER_SKIN_MAP = {
  Hunter_Pray: 'Skin_Nymph_D_Default',
  Skin_Pray_D_Default: 'Skin_Nymph_D_Default',
  Hunter_Werewolf: 'Skin_Nylcan_D_Default',
  Skin_Werewolf_D_Default: 'Skin_Nylcan_D_Default',
  Survivor_Security: 'Skin_SeGuard_D_Default',
  Skin_Security_D_Default: 'Skin_SeGuard_D_Default',
  Survivor_StudentF: 'Skin_Student_D_Default',
  Skin_StudentF_D_Default: 'Skin_Student_D_Default',
  Survivor_JapanTouristF: 'Skin_TouristJap_D_Default',
  Skin_JapanTouristF_D_Default: 'Skin_TouristJap_D_Default',
};

const INVENTORY_DEFAULTS = {
  devAccount: false,
  characters: [],
  items: [],
  itemCounts: [],
  skins: [],
  perks: [],
  profiles: [],
  stickers: [],
  heads: [],
  backs: [],
  costumes: [],
  rituals: [],
  cosmeticconsume: [],
  bundles: [],
  poses: [],
  effects: [],
  lootBoxAmount: 50,
  bulletAmount: 50,
};

const ITEM_CATEGORY_RULES = [
  { matches: (itemId) => itemId.startsWith('Hunter_') || itemId.startsWith('Survivor_'), category: 'characters' },
  { matches: (itemId) => itemId.startsWith('Skin_'), category: 'skins' },
  { matches: (itemId) => itemId.startsWith('PP_'), category: 'perks' },
  { matches: (itemId) => itemId.startsWith('Profile_'), category: 'profiles' },
  { matches: (itemId) => itemId.startsWith('Sticker_'), category: 'stickers' },
  { matches: (itemId) => itemId.startsWith('Head_'), category: 'heads' },
  { matches: (itemId) => itemId.startsWith('Back_'), category: 'backs' },
  { matches: (itemId) => itemId.startsWith('Pose_'), category: 'poses' },
  { matches: (itemId) => itemId.startsWith('Bundle_'), category: 'bundles' },
  { matches: (itemId) => itemId.startsWith('FX_Warden_Transform_'), category: 'effects' },
  {
    matches: (itemId) =>
      itemId.startsWith('Item_Ritual') ||
      itemId.startsWith('Ritual_') ||
      itemId.startsWith('Item_Sacrifice'),
    category: 'rituals',
  },
  {
    matches: (itemId) =>
      itemId.startsWith('Item_') ||
      itemId.startsWith('HolyRice_') ||
      itemId.startsWith('HolyWater_') ||
      itemId.startsWith('Holywater_') ||
      itemId.startsWith('EnergyDrink_') ||
      itemId.startsWith('SacredThread_') ||
      itemId.startsWith('Syringe_') ||
      itemId.startsWith('Error_'),
    category: 'cosmeticconsume',
  },
];

const COSTUME_KEYWORDS = [
  '_Mask_',
  '_Puppet_',
  '_Scissors_',
  '_Cutter_',
  '_Armband_',
  '_Anklets_',
  '_Earring_',
  '_Earing_',
  '_Collar_',
  '_Belt_',
  '_Bracelet_',
  '_Necklace_',
  '_Gaiters_',
  '_KeyChain_',
  '_Chain_',
  '_Hook_',
  '_Katana_',
  '_Rapier_',
  '_Knife_',
  '_Pet_',
  '_Rabbit_',
  '_Sheep_',
  '_Deer_',
  '_Bag_',
  '_Keyboard_',
  '_KeyBoard_',
  '_Mic_',
];

class InventoryService {
  getInventoryState(player) {
    return {
      ...INVENTORY_DEFAULTS,
      ...(player.inventory || {}),
      coin: player.coin || 0,
      amethyst: player.amethyst || 0,
      amulet: player.amulet || 0,
    };
  }

  getOwnedAliases(itemId) {
    const mappedItemId = CHARACTER_SKIN_MAP[itemId] || itemId;
    return [itemId, mappedItemId].filter(Boolean);
  }

  playerOwnsItem(player, itemId) {
    if (!itemId || itemId === 'None') {
      return true;
    }

    const inventory = this.getInventoryState(player);
    const ownedAliases = this.getOwnedAliases(itemId);

    return OWNERSHIP_CATEGORIES.some((category) =>
      ownedAliases.some((alias) => inventory[category]?.includes(alias))
    );
  }

  async updatePlayerProfile(player, profileId) {
    if (!this.playerOwnsItem(player, profileId)) {
      throw new Error('Profile not owned by player');
    }

    player.profile.display = profileId;
    player.profile.updatedAt = new Date();
    player.save_source = 'game';
    player._saveDataWrite = true;
    await player.save();

    return {
      display: player.profile.display,
      displayName: player.profile.displayName,
      updatedAt: player.profile.updatedAt,
    };
  }

  validateStickerData(stickerInfo) {
    const errors = [];

    if (
      stickerInfo.stickerpreset === undefined ||
      stickerInfo.stickerpreset < 0 ||
      stickerInfo.stickerpreset > 2
    ) {
      errors.push('Invalid sticker preset (must be 0, 1, or 2)');
    }

    if (!Array.isArray(stickerInfo.stickerSet) || stickerInfo.stickerSet.length !== 3) {
      errors.push('Sticker set must contain exactly 3 presets');
      return errors;
    }

    stickerInfo.stickerSet.forEach((preset, index) => {
      if (!Array.isArray(preset) || preset.length !== 8) {
        errors.push(`Sticker preset ${index} must contain exactly 8 stickers`);
      }
    });

    return errors;
  }

  async updatePlayerStickers(player, stickerInfo) {
    const validationErrors = this.validateStickerData(stickerInfo);

    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(', '));
    }

    for (const preset of stickerInfo.stickerSet) {
      for (const sticker of preset) {
        if (!this.playerOwnsItem(player, sticker)) {
          throw new Error(`Sticker not owned: ${sticker}`);
        }
      }
    }

    player.stickerSlot.stickerpreset = stickerInfo.stickerpreset;
    player.stickerSlot.stickerSet = stickerInfo.stickerSet;
    player.save_source = 'game';
    player._saveDataWrite = true;
    await player.save();

    return {
      stickerpreset: player.stickerSlot.stickerpreset,
      stickerSet: player.stickerSlot.stickerSet,
    };
  }

  getCharacterSlotData(player) {
    if (!player.characterSlot) {
      return null;
    }
    // A saved loadout is player state, not an inventory grant. Returning only
    // inventory-owned cosmetics here made valid saved outfits revert to defaults.
    return structuredClone(player.characterSlot);
  }

  collectSlotValidationErrors(player, slots = [], slotLabel, cosmeticFields) {
    const errors = [];

    for (const slot of slots) {
      if (slot.character && !this.playerOwnsItem(player, slot.character)) {
        errors.push(`${slotLabel} character not owned: ${slot.character}`);
      }

      for (const cosmeticField of cosmeticFields) {
        const cosmetic = slot[cosmeticField];

        if (cosmetic && cosmetic !== 'None' && !this.playerOwnsItem(player, cosmetic)) {
          errors.push(`Cosmetic not owned: ${cosmetic}`);
        }
      }

      for (const perk of slot.perkPassive || []) {
        if (perk && perk !== 'None' && !this.playerOwnsItem(player, perk)) {
          errors.push(`Perk not owned: ${perk}`);
        }
      }
    }

    return errors;
  }

  validateCharacterSlot(player, slotData) {
    const errors = [];
    for (const key of ['hunterSlot', 'survivorSlot']) {
      if (slotData[key] !== undefined && !Array.isArray(slotData[key])) errors.push(`${key} must be an array`);
      if (Array.isArray(slotData[key]) && (slotData[key].length > 32 || slotData[key].some(slot => !slot || typeof slot !== 'object' || Array.isArray(slot)))) {
        errors.push(`${key} contains invalid slot data`);
      }
    }
    for (const key of ['characterhunteritem', 'characteritem']) {
      if (slotData[key] !== undefined && typeof slotData[key] !== 'string') errors.push(`${key} must be a string`);
    }
    if (Buffer.byteLength(JSON.stringify(slotData), 'utf8') > 200 * 1024) errors.push('Character slot data is too large');
    return errors;
  }

  sanitizeCharacterSlots(player, slotData) {
    // Keep the complete loadout sent by the authenticated game client. Do not
    // change the inventory/ownership lists as a side effect of saving it.
    return structuredClone(slotData);
  }

  mergeLoadoutValue(previous, incoming) {
    if (Array.isArray(incoming)) return structuredClone(incoming);
    if (!incoming || typeof incoming !== 'object') return incoming;
    const result = previous && typeof previous === 'object' && !Array.isArray(previous)
      ? structuredClone(previous) : {};
    for (const [key, value] of Object.entries(incoming)) {
      result[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? this.mergeLoadoutValue(result[key], value)
        : structuredClone(value);
    }
    return result;
  }

  mergeCharacterLoadouts(previous = [], incoming = []) {
    // An explicitly submitted empty array means the game cleared this list.
    // Do not silently resurrect the old outfits in that case.
    if (Array.isArray(incoming) && incoming.length === 0) return [];
    if (!Array.isArray(previous) || !previous.length) return structuredClone(incoming);
    if (!Array.isArray(incoming) || !incoming.length) return structuredClone(previous);
    const identity = (slot, index) => String(
      slot.character ?? slot.characterId ?? slot.slotId ?? slot.id ?? `index:${index}`
    );
    const oldById = new Map(previous.map((slot, index) => [identity(slot, index), slot]));
    const merged = incoming.map((slot, index) => {
      const key = identity(slot, index);
      const oldSlot = oldById.get(key);
      oldById.delete(key);
      return oldSlot ? this.mergeLoadoutValue(oldSlot, slot) : structuredClone(slot);
    });
    // A partial update can contain only the currently selected character.
    // Keep the other characters' saved outfits instead of replacing the list.
    for (const slot of previous) {
      if (oldById.size === 0) break;
      const key = identity(slot, previous.indexOf(slot));
      if (oldById.has(key)) {
        merged.push(structuredClone(slot));
        oldById.delete(key);
      }
    }
    return merged;
  }

  async updateCharacterSlot(player, slotData, role) {
    const sanitizedSlotData = this.sanitizeCharacterSlots(player, slotData);
    const validationErrors = this.validateCharacterSlot(player, sanitizedSlotData);

    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(', '));
    }

    let hasChanges = false;
    const current = player.characterSlot && typeof player.characterSlot === 'object'
      ? player.characterSlot : {};
    const merged = structuredClone(current);
    for (const [key, value] of Object.entries(sanitizedSlotData)) {
      if (key === 'hunterSlot' || key === 'survivorSlot') {
        merged[key] = this.mergeCharacterLoadouts(current[key] || [], value);
      } else {
        merged[key] = this.mergeLoadoutValue(current[key], value);
      }
    }
    player.characterSlot = merged;
    hasChanges = Object.keys(sanitizedSlotData).length > 0;

    if (role !== undefined && ['hunter', 'survivor'].includes(role)) {
      player.role = role;
      hasChanges = true;
    }

    if (hasChanges) {
      player.markModified('characterSlot');
      player.save_source = 'game';
      player._saveDataWrite = true;
      await player.save();
    }

    return {
      slots: this.getCharacterSlotData(player),
      role: player.role,
    };
  }

  resolveInventoryCategory(itemId) {
    const directRule = ITEM_CATEGORY_RULES.find((rule) => rule.matches(itemId));

    if (directRule) {
      return directRule.category;
    }

    if (COSTUME_KEYWORDS.some((keyword) => itemId.includes(keyword))) {
      return 'costumes';
    }

    return 'items';
  }

  ensureInventoryArrays(inventory) {
    Object.entries(INVENTORY_DEFAULTS).forEach(([key, value]) => {
      if (Array.isArray(value) && !Array.isArray(inventory[key])) {
        inventory[key] = [];
      }
    });
  }

  async addItemToInventory(player, itemId, quantity = 1) {
    const inventory = player.inventory;
    this.ensureInventoryArrays(inventory);

    const category = this.resolveInventoryCategory(itemId);

    if (category === 'items') {
      const existingIndex = inventory.items.indexOf(itemId);

      if (existingIndex > -1) {
        inventory.itemCounts[existingIndex] = (inventory.itemCounts[existingIndex] || 0) + quantity;
      } else {
        inventory.items.push(itemId);
        inventory.itemCounts.push(quantity);
      }
    } else if (!inventory[category].includes(itemId)) {
      inventory[category].push(itemId);
    }

    player.markModified('inventory');
    await player.save();

    return { success: true, itemId, quantity };
  }

  async removeItemFromInventory(player, itemId) {
    const inventory = player.inventory;
    let removed = false;

    for (const category of OWNERSHIP_CATEGORIES) {
      const index = inventory[category]?.indexOf(itemId);

      if (index === undefined || index < 0) {
        continue;
      }

      inventory[category].splice(index, 1);

      if (category === 'items') {
        inventory.itemCounts.splice(index, 1);
      }

      removed = true;
    }

    if (removed) {
      player.markModified('inventory');
      await player.save();
    }

    return { success: removed, itemId };
  }
}

module.exports = new InventoryService();
