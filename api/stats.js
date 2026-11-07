// TRIPPED shared stats: the global "fed him N mushrooms" counter and the rug wall.
// Vercel Node function, no dependencies. Storage: Upstash Redis over REST.
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//   GET  /api/stats                         -> { configured, fed, rugs: [{ ticker, n }] (top 30) }
//   POST /api/stats { type: "fed", n }      -> adds n (1-20) mushrooms, per-IP cap per minute
//   POST /api/stats { type: "rug", ticker } -> ZINCRBY trip:rugs <TICKER> 1, returns its new count
import { createHash } from 'node:crypto';

const PREFIX = 'trip:';
const FED = PREFIX + 'fed';
const RUGS = PREFIX + 'rugs';
const FED_PER_POST = 20;
const FED_PER_MIN = 60;   // per IP
const RUGS_PER_MIN = 8;   // per IP
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
      req.on('data', (c) => { s += c; if (s.length > 2048) { reject(new Error('too big')); req.destroy(); } });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }
  if (raw.length > 2048) throw new Error('too big');
  return raw ? JSON.parse(raw) : {};
}
function ipHash(req) {
  const xf = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(xf) ? xf[0] : xf || '').split(',')[0].trim() || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
  return createHash('sha256').update('tripped-stats:' + ip).digest('hex').slice(0, 40);
}
export function cleanTicker(input) {
  if (typeof input !== 'string') return null;
  const t = input.trim().replace(/^\$+/, '').toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(t)) return null;
  const flat = t.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
  if (ABUSE.some((w) => flat.includes(w))) return null;
  return t;
}
// fixed one-minute window per IP; returns how many units are still allowed
async function allowance(cfg, key, want, cap) {
  const [, used] = await pipeline(cfg, [['SET', key, '0', 'EX', '60', 'NX'], ['INCRBY', key, String(want)]]);
  const over = Math.max(0, Number(used) - cap);
  return Math.max(0, want - over);
}

export default async function handler(req, res) {
  const cfg = kv();
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!cfg) return send(res, 200, { configured: false }, 'public, s-maxage=10, stale-while-revalidate=20');
      const [fed, flat] = await pipeline(cfg, [['GET', FED], ['ZREVRANGE', RUGS, '0', '29', 'WITHSCORES']]);
      const rugs = [];
      for (let i = 0; i + 1 < (flat || []).length; i += 2) {
        const ticker = String(flat[i]);
        if (/^[A-Z0-9]{1,12}$/.test(ticker)) rugs.push({ ticker, n: Math.round(Number(flat[i + 1]) || 0) });
      }
      return send(res, 200, { configured: true, fed: Number(fed) || 0, rugs }, 'public, s-maxage=10, stale-while-revalidate=20');
    }

    if (req.method === 'POST') {
      if (!cfg) return send(res, 503, { ok: false, configured: false, error: 'opens soon.' });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad request.' }); }
      if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'bad request.' });
      const who = ipHash(req);

      if (body.type === 'fed') {
        const n = Math.floor(Number(body.n));
        if (!Number.isFinite(n) || n < 1) return send(res, 400, { ok: false, error: 'bad count.' });
        const want = Math.min(FED_PER_POST, n);
        const ok = await allowance(cfg, PREFIX + 'fedrl:' + who, want, FED_PER_MIN);
        if (!ok) { const [fed] = await pipeline(cfg, [['GET', FED]]); return send(res, 429, { ok: false, accepted: 0, fed: Number(fed) || 0, error: 'slow down.' }); }
        const [fed] = await pipeline(cfg, [['INCRBY', FED, String(ok)]]);
        return send(res, 200, { ok: true, accepted: ok, fed: Number(fed) || 0 });
      }

      if (body.type === 'rug') {
        const ticker = cleanTicker(body.ticker);
        if (!ticker) return send(res, 400, { ok: false, error: 'letters and numbers only. max 12.' });
        const ok = await allowance(cfg, PREFIX + 'rugrl:' + who, 1, RUGS_PER_MIN);
        if (!ok) { const [n] = await pipeline(cfg, [['ZSCORE', RUGS, ticker]]); return send(res, 429, { ok: false, ticker, n: Math.round(Number(n) || 0), error: 'slow down.' }); }
        const [n] = await pipeline(cfg, [['ZINCRBY', RUGS, '1', ticker], ['ZREMRANGEBYRANK', RUGS, '0', '-2001']]);
        return send(res, 200, { ok: true, ticker, n: Math.round(Number(n) || 0) });
      }

      return send(res, 400, { ok: false, error: 'unknown type.' });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'method not allowed.' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'busy. try again.' });
  }
}
