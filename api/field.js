// TRIPPED shared field: everyone's planted mushrooms.
// Vercel Node function, no dependencies. Storage: Upstash Redis over REST.
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
import { createHash } from 'node:crypto';

const PREFIX = 'trip:';
const LIST = PREFIX + 'plants';
const COUNT = PREFIX + 'count';
const MAX = 1500;
const COLORS = ['#b6ff3a', '#ff4fd8', '#3af0ff', '#ff9a3a', '#8b5cff'];
const R_MIN = 6, R_MAX = 40;

const RESERVED = new Set([
  'admin', 'administrator', 'official', 'support', 'help', 'team', 'dev', 'devs', 'mod', 'mods', 'moderator',
  'tripped', 'trip', 'tripofficial', 'trip_official', 'pumpfun', 'pump_fun', 'solana', 'phantom', 'dexscreener',
  'anon', 'null', 'undefined', 'root', 'system', 'claim', 'airdrop', 'giveaway', 'wallet', 'support_team',
]);
// short abuse list, matched on a de-leeted, underscore-free copy of the handle
const ABUSE = ['nigg', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'tranny', 'nazi', 'hitler', 'rapist', 'pedophil', 'molest', 'cunt', 'whore', 'killyourself', 'drainer'];

function kv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

async function pipeline(cfg, cmds) {
  const r = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('kv http ' + r.status);
  const out = await r.json();
  return out.map((x) => { if (x && x.error) throw new Error('kv ' + x.error); return x ? x.result : null; });
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else {
    raw = await new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 4096) { reject(new Error('too big')); req.destroy(); } });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }
  if (raw.length > 4096) throw new Error('too big');
  return raw ? JSON.parse(raw) : {};
}

export function cleanHandle(input) {
  if (input == null) return { ok: true, handle: '' };
  if (typeof input !== 'string') return { ok: false };
  const h = input.trim().replace(/^@+/, '').toLowerCase();
  if (h === '') return { ok: true, handle: '' };
  if (!/^[a-z0-9_]{1,15}$/.test(h)) return { ok: false };
  if (RESERVED.has(h) || RESERVED.has(h.replace(/_/g, ''))) return { ok: false, reserved: true };
  const flat = h.replace(/_/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's');
  if (ABUSE.some((w) => flat.includes(w))) return { ok: false, reserved: true };
  return { ok: true, handle: h };
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xf) ? xf[0] : xf || '').split(',')[0].trim();
  return first || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function spot() {
  const r = Math.sqrt(R_MIN * R_MIN + Math.random() * (R_MAX * R_MAX - R_MIN * R_MIN));
  const a = Math.random() * Math.PI * 2;
  return { x: Math.round(Math.cos(a) * r * 100) / 100, z: Math.round(Math.sin(a) * r * 100) / 100 };
}

export default async function handler(req, res) {
  const cfg = kv();
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!cfg) return send(res, 200, { configured: false }, 'public, s-maxage=15, stale-while-revalidate=30');
      const [list, count] = await pipeline(cfg, [['LRANGE', LIST, '0', String(MAX - 1)], ['GET', COUNT]]);
      const plants = [];
      for (const s of list || []) {
        try {
          const p = JSON.parse(s);
          if (p && COLORS.includes(p.color) && Number.isFinite(p.x) && Number.isFinite(p.z)) plants.push({ handle: String(p.handle || ''), color: p.color, x: p.x, z: p.z, t: Number(p.t) || 0 });
        } catch {}
      }
      return send(res, 200, { configured: true, count: Math.max(Number(count) || 0, plants.length), plants }, 'public, s-maxage=15, stale-while-revalidate=30');
    }

    if (req.method === 'POST') {
      if (!cfg) return send(res, 503, { ok: false, configured: false, error: 'the field opens soon.' });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad request.' }); }
      if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'bad request.' });
      const h = cleanHandle(body.handle);
      if (!h.ok) return send(res, 400, { ok: false, error: h.reserved ? "that handle can't be planted." : 'letters, numbers and _ only. max 15.' });
      const color = typeof body.color === 'string' ? body.color.toLowerCase() : '';
      if (!COLORS.includes(color)) return send(res, 400, { ok: false, error: 'pick one of the colours.' });

      const ipHash = createHash('sha256').update('tripped-field:' + clientIp(req)).digest('hex').slice(0, 40);
      const rlKey = PREFIX + 'rl:' + ipHash;
      const [nx] = await pipeline(cfg, [['SET', rlKey, '1', 'NX', 'EX', '86400']]);
      if (nx !== 'OK') return send(res, 429, { ok: false, error: 'one mushroom per day. come back tomorrow.' });

      const plant = { handle: h.handle, color, ...spot(), t: Date.now() };
      try {
        const out = await pipeline(cfg, [['LPUSH', LIST, JSON.stringify(plant)], ['LTRIM', LIST, '0', String(MAX - 1)], ['INCR', COUNT]]);
        return send(res, 201, { ok: true, plant, count: Number(out[2]) || 0 });
      } catch (e) {
        try { await pipeline(cfg, [['DEL', rlKey]]); } catch {}
        throw e;
      }
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'method not allowed.' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'the field is busy. try again.' });
  }
}
