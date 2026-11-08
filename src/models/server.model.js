'use strict';

let client = null;
class ServerInfo {
  static configure(supabase) { client = supabase; }
  static async findOne() {
    if (!client) throw new Error('Supabase ServerInfo repository is not configured');
    const { data: db, error: dbError } = await client.from('admin_databases').select('id').eq('name', 'HSHO-PrivateServer').single();
    if (dbError) throw dbError;
    const { data: collection, error: collectionError } = await client.from('admin_collections').select('id').eq('database_id', db.id).eq('name', 'serverinfo').single();
    if (collectionError) throw collectionError;
    const { data: document, error } = await client.from('admin_documents').select('data').eq('collection_id', collection.id).order('created_at').limit(1).maybeSingle();
    if (error) throw error;
    if (!document) return null;
    return {
      ...document.data,
      serverVersion: document.data.serverVersion || document.data.server_version,
      IsOnline: document.data.IsOnline ?? document.data.is_online ?? true,
      IsDevOnline: document.data.IsDevOnline ?? document.data.is_dev_online ?? false
    };
  }
}
module.exports = ServerInfo;
