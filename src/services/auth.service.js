'use strict';

const crypto = require('node:crypto');
const config = require('@config');
const Player = require('@models/player.model');

const b64 = value => Buffer.from(value).toString('base64url');
function sign(unsigned) { return crypto.createHmac('sha256', config.jwt.secret).update(unsigned).digest('base64url'); }

class AuthService {
  generateJWT(steamId) {
    if (!config.jwt.secret) throw new Error('GAME_SESSION_SECRET is not configured');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ steamId, type: 'session', iat: now, exp: now + config.jwt.sessionExpiry }))}`;
    return `${unsigned}.${sign(unsigned)}`;
  }

  async verifyToken(token) {
    if (!config.jwt.secret || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const unsigned = `${parts[0]}.${parts[1]}`;
    const actual = Buffer.from(parts[2]);
    const expected = Buffer.from(sign(unsigned));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
    if (claims.type !== 'session' || !/^\d{17}$/.test(String(claims.steamId || '')) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) return null;
    const player = await Player.findOne({ steamId: claims.steamId });
    return player?.session_token === token ? player : null;
  }

  async verifySteamTicket(ticket) {
    if (!/^(?:[a-f0-9]{2}){20,8192}$/i.test(String(ticket || ''))) return { success: false, error: 'Invalid Steam session ticket' };
    if (!config.steam.apiKey || !/^\d+$/.test(String(config.steam.appId))) return { success: false, error: 'Steam ticket validation is not configured' };
    try {
      const host = ['api.steampowered.com', 'partner.steam-api.com'].includes(String(config.steam.apiHost).toLowerCase()) ? String(config.steam.apiHost).toLowerCase() : 'api.steampowered.com';
      const url = new URL(`https://${host}/ISteamUserAuth/AuthenticateUserTicket/v1/`);
      url.searchParams.set('key', config.steam.apiKey);
      url.searchParams.set('appid', config.steam.appId);
      url.searchParams.set('ticket', ticket);
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const text = await response.text();
      if (!response.ok) return { success: false, error: `Steam returned HTTP ${response.status}` };
      let body;
      try { body = JSON.parse(text); } catch { return { success: false, error: 'Steam returned an invalid response' }; }
      const steamId = String(body?.response?.params?.steamid || '');
      return /^\d{17}$/.test(steamId) ? { success: true, steamId } : { success: false, error: 'Steam rejected the session ticket' };
    } catch (error) {
      console.error('[Steam Auth]', error.message);
      return { success: false, error: 'Could not verify Steam ticket' };
    }
  }

  async getSteamPlayerName(steamId) { return `Player_${String(steamId).slice(-6)}`; }
  extractToken(req) { return req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.body?.session_token || req.headers['x-access-token']; }
}

module.exports = new AuthService();
