'use strict';

function createWhitelistRepository(supabase) {
  if (!supabase) throw new Error('Supabase client is required');
  return {
    async findBySteamId(steamId) {
      const { data, error } = await supabase.from('whitelists').select('*').eq('steam_id', String(steamId)).maybeSingle();
      if (error) throw error;
      return data;
    },
    async saveGameSession(id, fields) {
      const { data, error } = await supabase.from('whitelists').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error) throw error;
      return data;
    }
  };
}

module.exports = { createWhitelistRepository };
