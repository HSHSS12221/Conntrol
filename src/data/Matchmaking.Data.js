'use strict';

// ---------------------------------------------------------------------------
// Matchmaking.Data file — durable snapshot of the matchmaking queue.
//
// Stored as { file: 'Matchmaking.Data', queue: [...], updated_at } in the
// `data` collection of admin_documents. The in-memory queue stays
// authoritative for pairing (one Node process, no lost updates); this file
// only makes a search survive a Render restart: it is loaded lazily on the
// first matchmaking request after boot and written back after every change.
// Rooms themselves stay one document each in the `game_rooms` collection.
// ---------------------------------------------------------------------------

const { createDataCollection } = require('./data.collection');

const FILE_NAME = 'Matchmaking.Data';

function createMatchmakingDataFile({ supabase, log } = {}) {
  if (!supabase) return null;
  const dataCollectionId = createDataCollection({ supabase, log });

  async function findDocument() {
    const cid = await dataCollectionId();
    const { data, error } = await supabase.from('admin_documents')
      .select('id,data')
      .eq('collection_id', cid)
      .eq('data->>file', FILE_NAME)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data || [])[0] || null;
  }

  return {
    // Returns the stored queue entries (already shape-checked); [] when the
    // file does not exist yet.
    async loadQueue() {
      const row = await findDocument();
      const queue = row?.data?.queue;
      if (!Array.isArray(queue)) return [];
      return queue.filter(entry =>
        entry && typeof entry === 'object' && !Array.isArray(entry) &&
        typeof entry.steamId === 'string' && Number.isFinite(Number(entry.at)));
    },

    // Writes the whole queue snapshot (single document, last write wins —
    // the caller is the one in-memory array, so this cannot tear).
    async saveQueue(queue) {
      const cid = await dataCollectionId();
      const payload = {
        file: FILE_NAME,
        queue: (Array.isArray(queue) ? queue : []).map(entry => ({
          steamId: String(entry.steamId || ''),
          displayName: String(entry.displayName || 'Player'),
          gameMode: String(entry.gameMode || 'default'),
          region: String(entry.region || 'auto'),
          at: Number(entry.at) || Date.now(),
        })).filter(entry => entry.steamId),
        updated_at: new Date().toISOString(),
      };
      const existing = await findDocument();
      if (existing) {
        const { error } = await supabase.from('admin_documents')
          .update({ data: payload, updated_at: payload.updated_at })
          .eq('id', existing.id);
        if (error) throw error;
        return payload;
      }
      const { error } = await supabase.from('admin_documents')
        .insert({ collection_id: cid, data: payload });
      if (error) throw error;
      return payload;
    },
  };
}

module.exports = { createMatchmakingDataFile, FILE_NAME };
