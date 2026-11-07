'use strict';

module.exports = {
  env: process.env.NODE_ENV || 'production',
  port: Number(process.env.PORT || 3000),
  version: process.env.VERSION || 'prod',
  developers: process.env.DEVELOPERS ? process.env.DEVELOPERS.split(',').map(value => value.trim()).filter(Boolean) : [],
  supabase: { url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY },
  jwt: { secret: process.env.GAME_SESSION_SECRET || '', sessionExpiry: 24 * 60 * 60 },
  steam: { apiKey: process.env.STEAM_PUBLISHER_KEY || '', appId: process.env.STEAM_APP_ID || '480' },
  server: { version: process.env.SERVER_VERSION || '1.0.6.0' }
};
