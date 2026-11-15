'use strict';

// ---------------------------------------------------------------------------
// Shared access to the `data` collection of the admin explorer's
// HSHO-PrivateServer database. The collection is created on demand so the
// Player.Save.Data and Matchmaking.Data files work on deployments that have
// not run schema.sql yet: admin_databases / admin_collections /
// admin_documents already exist because the launcher's serverinfo flow uses
// them every boot.
// ---------------------------------------------------------------------------

const DATA_COLLECTION = 'data';

function createDataCollection({ supabase, log } = {}) {
  let cachedId = null;
  let pendingId = null;

  async function dataCollectionId() {
    if (!supabase) throw new Error('Game database is not configured');
    if (cachedId) return cachedId;
    if (pendingId) return pendingId;
    pendingId = (async () => {
      try {
        const { data: dbRow, error: dbError } = await supabase
          .from('admin_databases').select('id').eq('name', 'HSHO-PrivateServer').single();
        if (dbError) throw dbError;
        const { data: existing, error: findError } = await supabase
          .from('admin_collections').select('id')
          .eq('database_id', dbRow.id).eq('name', DATA_COLLECTION).maybeSingle();
        if (findError) throw findError;
        if (existing) { cachedId = existing.id; return cachedId; }
        const { data: created, error: createError } = await supabase
          .from('admin_collections')
          .insert({ database_id: dbRow.id, name: DATA_COLLECTION })
          .select('id').single();
        if (createError) {
          // A concurrent request may have created the collection first; re-read once.
          const { data: again, error: reError } = await supabase
            .from('admin_collections').select('id')
            .eq('database_id', dbRow.id).eq('name', DATA_COLLECTION).maybeSingle();
          if (reError) throw reError;
          if (!again) throw createError;
          cachedId = again.id;
        } else {
          cachedId = created.id;
          if (log) log('info', 'Player Save', `Created the ${DATA_COLLECTION} collection for Player.Save.Data / Matchmaking.Data files`, 200);
        }
        return cachedId;
      } finally {
        pendingId = null;
      }
    })();
    return pendingId;
  }

  return dataCollectionId;
}

module.exports = { createDataCollection, DATA_COLLECTION };
