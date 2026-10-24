'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || './music');
const CACHE_TTL = 60_000;
const searchCache = new Map();
const streamCache = new Map();
const UA = 'BitChord-FastLossless/1.0 (personal music source)';

const manifest = {
  id: 'com.custom.bitchord.fastlossless',
  name: 'Fast Lossless (Archive + Personal Library)',
  version: '1.0.0',
  description: 'Fast FLAC search with bounded timeouts, short caching, and fallback to a personal FLAC library. Internet Archive results should be public-domain or appropriately licensed.',
  author: 'Personal',
  resources: ['search', 'stream'],
  types: ['track'],
  contentType: 'music'
};

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(data));
}
function clean(s) { return String(s || '').replace(/[<>\u0000-\u001f]/g, ' ').trim(); }
function key(s) { return clean(s).toLowerCase().replace(/\.(flac|wav|mp3|m4a|ogg)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout')), ms))]);
}
async function getJson(url, timeout = 4500) {
  const r = await withTimeout(fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeout) }), timeout + 100, 'request');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function walkFlac(dir, out = [], depth = 0) {
  if (depth > 5 || out.length >= 3000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFlac(p, out, depth + 1);
    else if (e.isFile() && /\.flac$/i.test(e.name)) out.push(p);
    if (out.length >= 3000) break;
  }
  return out;
}
function localSearch(q, limit) {
  const needle = key(q);
  if (!needle) return [];
  return walkFlac(MUSIC_DIR).map(file => {
    const base = path.basename(file, path.extname(file));
    const norm = key(base);
    let score = norm === needle ? 100 : norm.includes(needle) ? 60 : needle.split(' ').filter(t => norm.includes(t)).length * 8;
    const split = base.split(' - ');
    return { id: 'local:' + Buffer.from(file).toString('base64url'), title: split.length > 1 ? split.slice(1).join(' - ').trim() : base, artist: split.length > 1 ? split[0].trim() : 'Personal Library', album: '', duration: 0, format: 'flac', audioQuality: 'LOSSLESS', _score: score, _local: true, _file: file };
  }).filter(x => x._score > 0).sort((a,b) => b._score-a._score).slice(0, limit);
}
async function archiveSearch(q, limit) {
  // Search a wider set of Archive audio records because many top-level records do not contain FLAC files.
  // Metadata checks are parallel but bounded; only actual .flac files are returned as lossless.
  const safeQuery = clean(q).replace(/[(){}\[\]"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ q: `(${safeQuery}) AND mediatype:audio`, fl: 'identifier,title,creator', rows: '60', page: '1', output: 'json' });
  const data = await getJson('https://archive.org/advancedsearch.php?' + params.toString(), 6000);
  const docs = data && data.response && data.response.docs || [];
  const candidates = docs.slice(0, 30);
  const expanded = await Promise.all(candidates.map(async doc => {
    try {
      const meta = await getJson('https://archive.org/metadata/' + encodeURIComponent(doc.identifier), 4500);
      const files = (meta.files || []).filter(f => /\.flac$/i.test(f.name || '') && !f.source && !f.private && Number(f.size || 0) > 0);
      return files.slice(0, 4).map(f => {
        const name = path.basename(f.name, path.extname(f.name)).replace(/[_]/g, ' ').replace(/^\d+[ ._-]+/, '');
        return { id: 'ia:' + encodeURIComponent(doc.identifier) + ':' + encodeURIComponent(f.name), title: name || clean(doc.title), artist: clean(Array.isArray(doc.creator) ? doc.creator[0] : doc.creator) || 'Internet Archive', album: clean(doc.title), duration: Number(f.length || 0) || 0, format: 'flac', audioQuality: 'LOSSLESS', _score: 10, _ia: true };
      });
    } catch { return []; }
  }));
  return expanded.flat().slice(0, limit);
}
function publicTrack(t) {
  const { _score, _local, _file, _ia, ...cleanTrack } = t;
  return cleanTrack;
}
function streamUrlForId(id) {
  if (id.startsWith('ia:')) {
    const rest = id.slice(3); const sep = rest.indexOf(':');
    if (sep < 0) throw new Error('Invalid Archive id');
    const item = decodeURIComponent(rest.slice(0, sep));
    const file = decodeURIComponent(rest.slice(sep + 1));
    if (!/^[A-Za-z0-9._-]+$/.test(item) || file.split('/').includes('..')) throw new Error('Invalid Archive path');
    return 'https://archive.org/download/' + encodeURIComponent(item) + '/' + file.split('/').map(encodeURIComponent).join('/');
  }
  if (id.startsWith('local:')) {
    const file = Buffer.from(id.slice(6), 'base64url').toString('utf8');
    const resolved = path.resolve(file);
    if (!resolved.startsWith(MUSIC_DIR + path.sep) && resolved !== MUSIC_DIR) throw new Error('Path outside music library');
    if (!fs.existsSync(resolved) || !resolved.toLowerCase().endsWith('.flac')) throw new Error('Local FLAC not found');
    return { localFile: resolved };
  }
  throw new Error('Unknown track source');
}
async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'Content-Type' }); return res.end(); }
  if (u.pathname === '/' || u.pathname === '/manifest.json') return send(res, 200, manifest, { 'cache-control': 'public, max-age=300' });
  if (u.pathname === '/health') return send(res, 200, { ok: true, localLibrary: fs.existsSync(MUSIC_DIR), source: 'Internet Archive + personal FLAC library' });
  const localStreamMatch = u.pathname.match(/^\/local-stream\/([A-Za-z0-9_-]+)$/);
  if (localStreamMatch) {
    try {
      const file = Buffer.from(localStreamMatch[1], 'base64url').toString('utf8');
      const resolved = path.resolve(file);
      if ((!resolved.startsWith(MUSIC_DIR + path.sep) && resolved !== MUSIC_DIR) || !resolved.toLowerCase().endsWith('.flac') || !fs.existsSync(resolved)) { res.writeHead(404); return res.end('Not found'); }
      const size = fs.statSync(resolved).size;
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        if (!m) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { 'content-type': 'audio/flac', 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'access-control-allow-origin': '*' });
        return fs.createReadStream(resolved, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'content-type': 'audio/flac', 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' });
      return fs.createReadStream(resolved).pipe(res);
    } catch { res.writeHead(404); return res.end('Not found'); }
  }
  if (u.pathname === '/search') {
    const q = clean(u.searchParams.get('q') || u.searchParams.get('query'));
    const limit = Math.max(1, Math.min(25, Number(u.searchParams.get('limit') || 20)));
    if (!q) return send(res, 200, { tracks: [], total: 0 });
    const cacheKey = key(q) + ':' + limit; const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL) return send(res, 200, cached.data, { 'cache-control': 'public, max-age=30' });
    const local = localSearch(q, limit);
    let archive = [];
    try { archive = await archiveSearch(q, Math.max(1, limit - local.length)); } catch { /* source fallback: keep local results */ }
    const seen = new Set(); const tracks = [];
    for (const t of [...local, ...archive]) {
      const k = key(t.title) + '|' + key(t.artist);
      if (!seen.has(k)) { seen.add(k); tracks.push(publicTrack(t)); }
      if (tracks.length >= limit) break;
    }
    const data = { tracks, total: tracks.length };
    searchCache.set(cacheKey, { at: Date.now(), data });
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    return send(res, 200, data, { 'cache-control': 'public, max-age=30' });
  }
  const streamMatch = u.pathname.match(/^\/stream\/([^/]+)$/);
  if (u.pathname === '/stream' || streamMatch) {
    const id = decodeURIComponent(streamMatch ? streamMatch[1] : (u.searchParams.get('id') || ''));
    if (!id) return send(res, 400, { error: 'Missing id' });
    const cached = streamCache.get(id);
    if (cached && Date.now() - cached.at < 4 * 60_000) return send(res, 200, cached.data, { 'cache-control': 'private, max-age=30' });
    try {
      const resolved = streamUrlForId(id);
      if (typeof resolved === 'string') {
        const data = { url: resolved, format: 'flac', quality: 'LOSSLESS', audioQuality: 'LOSSLESS', mimeType: 'audio/flac', manifest: 'none', encrypted: false };
        streamCache.set(id, { at: Date.now(), data });
        return send(res, 200, data, { 'cache-control': 'private, max-age=30' });
      }
      const st = fs.statSync(resolved.localFile);
      const publicBase = (process.env.PUBLIC_BASE_URL || (u.protocol + '//' + (req.headers.host || '127.0.0.1:8080'))).replace(/\/+$/, '');
      const localId = id.slice(6);
      const data = { url: publicBase + '/local-stream/' + localId, format: 'flac', quality: 'LOSSLESS', audioQuality: 'LOSSLESS', mimeType: 'audio/flac', manifest: 'none', encrypted: false, size: st.size };
      return send(res, 200, data);
    } catch (e) { return send(res, 404, { error: e.message }); }
  }
  return send(res, 404, { error: 'Not found' });
}
http.createServer((req, res) => route(req, res).catch(err => send(res, 500, { error: 'Internal error', detail: process.env.NODE_ENV === 'development' ? String(err.message) : undefined }))).listen(PORT, HOST, () => console.log(`Fast Lossless addon listening on http://${HOST}:${PORT}`));
