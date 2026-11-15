'use strict';

// ---------------------------------------------------------------------------
// Player.Save.Data file — the durable Save Data store for the game client.
//
// Every player's save document is kept in the Supabase admin_documents table
// under the `data` collection as:
//
//   { file: 'Player.Save.Data', steam_id, save: {...}, updated_at }
//
// The admin explorer lists it like a file. Unlike the whitelists.save_data
// columns (which schema.sql adds), this store needs no migration, so game
// saves keep persisting even on databases created from the older schema.
// ---------------------------------------------------------------------------

const { createDataCollection } = require('./data.collection');

const FILE_NAME = 'Player.Save.Data';

function createPlayerSaveDataFile({ supabase, log } = {}) {
  if (!supabase) return null;
  const dataCollectionId = createDataCollection({ supabase, log });

  async function findDocument(steamId) {
    const cid = await dataCollectionId();
    const { data, error } = await supabase.from('admin_documents')
      .select('id,data')
      .eq('collection_id', cid)
      .eq('data->>file', FILE_NAME)
      .eq('data->>steam_id', String(steamId))
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = (data || [])[0];
    if (!row) return null;
    return { docId: row.id, ...(row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {}) };
  }

  return {
    // Returns the stored Save Data document, or null when the player has no
    // Player.Save.Data file yet.
    async read(steamId) {
      if (!steamId) return null;
      const doc = await findDocument(steamId);
      if (!doc) return null;
      const { save } = doc;
      return save && typeof save === 'object' && !Array.isArray(save) ? save : null;
    },

    // Upserts the player's Player.Save.Data file. The envelope fields stay
    // top-level so the document can be found again with data->>steam_id.
    async write(steamId, save) {
      if (!steamId) throw new Error('A SteamID is required to write Player.Save.Data');
      const cid = await dataCollectionId();
      const payload = {
        file: FILE_NAME,
        steam_id: String(steamId),
        save: save && typeof save === 'object' && !Array.isArray(save) ? save : {},
        updated_at: new Date().toISOString(),
      };
      const existing = await findDocument(steamId);
      if (existing?.docId) {
        const { error } = await supabase.from('admin_documents')
          .update({ data: payload, updated_at: payload.updated_at })
          .eq('id', existing.docId);
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

module.exports = { createPlayerSaveDataFile, FILE_NAME };
