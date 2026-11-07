'use strict';

const { createGameDataService } = require('../services/game-data.service');
let gameDataService = null;

function configure(supabase) { gameDataService = createGameDataService(supabase); }

module.exports = {
  configure,
  async load(jsonPath) {
    if (!gameDataService) throw new Error('Supabase game data service is not configured');
    const item = await gameDataService.get(jsonPath.startsWith('static/') ? jsonPath : `static/${jsonPath}`);
    if (!item) throw new Error(`Game data file has not been synced to Supabase: ${jsonPath}`);
    return item.data;
  },
  serve(jsonPath) {
    return async (_req, res) => {
      try { return res.json(await module.exports.load(jsonPath)); }
      catch (error) { console.error('[Game Data]', error.message); return res.status(503).json({ status: 0, data: null, error: 'Game data is not available from Supabase' }); }
    };
  }
};
