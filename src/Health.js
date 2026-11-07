'use strict';

const router = require('express').Router();
let client = null;
router.configure = supabase => { client = supabase; };
router.get('/health/game-api', async (_req, res) => {
  if (!client) return res.status(503).json({ status: 'unavailable', database: 'not_configured' });
  const { error } = await client.from('whitelists').select('id', { head: true, count: 'exact' }).limit(1);
  if (error) return res.status(503).json({ status: 'unavailable', database: 'error' });
  return res.json({ status: 'ok', database: 'supabase' });
});
module.exports = router;
