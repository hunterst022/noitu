'use strict';
/**
 * NỐI TỪ ĐẠI CHIẾN - server cho TikTok Live
 *  - Kết nối chat TikTok Live (tiktok-live-connector)
 *  - Chấm đáp án: người đúng SỚM NHẤT thắng, chuyển từ ngay
 *  - Đẩy sự kiện tới overlay qua Server-Sent Events (không cần thư viện ngoài)
 *
 * Chạy thật : node server.js            (điền tiktokUsername trong config.json)
 * Chạy demo : node server.js demo       (bot giả lập người chơi, không cần mạng)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DEMO = process.argv.includes('demo');

// ---------- Config ----------
const DEFAULTS = {
  tiktokUsername: '', host: '127.0.0.1', port: 3000,
  title1: 'NỐI TỪ', title2: 'ĐẠI CHIẾN', kicker: 'THỬ THÁCH CẢ PHÒNG LIVE', subtitle: 'Comment đúng — chuyển từ ngay!',
  syllables: 2, dictionaryMode: 'loose',
  basePoints: 100, comboBonus: 20, comboWindowSec: 20, speedBonusSec: 5, speedBonus: 50,
  hintAfterSec: 20, skipAfterSec: 60, chainShown: 5,
  voice: { enabled: true, rate: 1.05, pitch: 1.15, volume: 1 },
  music: { enabled: true, volume: 0.22, file: '' },
  sfxVolume: 0.7, welcome: true,
};
function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { console.warn('[config] Không đọc được config.json, dùng mặc định:', e.message); }
  const c = { ...DEFAULTS, ...user };
  c.voice = { ...DEFAULTS.voice, ...(user.voice || {}) };
  c.music = { ...DEFAULTS.music, ...(user.music || {}) };
  return c;
}
const CFG = loadConfig();
// Biến môi trường (Render) ghi đè config.json
if (process.env.TIKTOK_USERNAME) CFG.tiktokUsername = process.env.TIKTOK_USERNAME;
if (process.env.PORT) { CFG.port = Number(process.env.PORT); if (!process.env.HOST) CFG.host = '0.0.0.0'; }
if (process.env.HOST) CFG.host = process.env.HOST;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || ROOT;
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const MAX_UPLOAD = 30 * 1024 * 1024; // đặt về ổ đĩa bền (Render Disk) nếu muốn giữ bảng vàng

// ---------- Từ điển ----------
const LETTERS = 'a-zàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
const SYL_RE = new RegExp('^[' + LETTERS + ']{1,7}$');
const VOWEL_RE = /[aàáảãạăằắẳẵặâầấẩẫậeèéẻẽẹêềếểễệiìíỉĩịoòóỏõọôồốổỗộơờớởỡợuùúủũụưừứửữựyỳýỷỹỵ]/;

const norm = (s) => String(s || '').normalize('NFC').toLowerCase()
  .replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const DICT = new Set();
const BY_FIRST = new Map(); // âm tiết đầu -> [từ]  (chỉ gồm từ còn nối tiếp được)
const KILL = new Set();     // từ cụt: nối vào là hết đường đi tiếp -> bị chặn
function loadDictionary() {
  let raw = '';
  try { raw = fs.readFileSync(path.join(ROOT, 'words.txt'), 'utf8'); }
  catch (e) { console.warn('[dict] Không đọc được words.txt:', e.message); }
  for (const line of raw.split(/\r?\n/)) {
    const w = norm(line);
    if (!w || line.trim().startsWith('#')) continue;
    if (w.split(' ').length !== CFG.syllables) continue;
    if (DICT.has(w)) continue;
    DICT.add(w);
    const f = w.split(' ')[0];
    if (!BY_FIRST.has(f)) BY_FIRST.set(f, []);
    BY_FIRST.get(f).push(w);
  }
  // Loại dây chuyền các từ cụt: chỉ giữ từ mà âm cuối của nó còn bắt đầu được một từ khác (cũng được giữ)
  const lastOf = (w) => w.split(' ').pop();
  for (let changed = true; changed;) {
    changed = false;
    const firsts = new Set([...BY_FIRST].filter(([, a]) => a.length).map(([f]) => f));
    for (const [f, arr] of BY_FIRST) {
      const keep = arr.filter((w) => firsts.has(lastOf(w)));
      if (keep.length !== arr.length) { arr.filter((w) => !firsts.has(lastOf(w))).forEach((w) => KILL.add(w)); BY_FIRST.set(f, keep); changed = true; }
    }
  }
  for (const [f, arr] of BY_FIRST) if (!arr.length) BY_FIRST.delete(f);
  console.log(`[dict] ${DICT.size} từ, ${KILL.size} từ cụt bị loại khỏi vòng chơi, ${DICT.size - KILL.size} từ dùng được.`);
}
loadDictionary();

const first = (w) => w.split(' ')[0];
const last = (w) => w.split(' ').pop();

// ---------- Kiểm tra âm tiết tiếng Việt (phụ âm đầu + vần + âm cuối + dấu thanh) ----------
const STOP = ['c', 'ch', 'p', 't'];
const C_ALL = ['c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't'], C_BACK = ['c', 'm', 'n', 'ng', 'p', 't'];
const NUC = {
  'a': [1, C_ALL], 'ă': [0, ['c', 'm', 'n', 'ng', 'p', 't']], 'â': [0, ['c', 'm', 'n', 'ng', 'p', 't']],
  'e': [1, C_BACK], 'ê': [1, ['ch', 'nh', 'm', 'n', 'p', 't']], 'i': [1, ['ch', 'nh', 'm', 'n', 'p', 't']], 'y': [1, []],
  'o': [1, C_BACK], 'ô': [1, C_BACK], 'ơ': [1, ['m', 'n', 'p', 't']], 'u': [1, C_BACK], 'ư': [1, ['c', 'ng', 't']],
  'oa': [1, C_ALL], 'oă': [0, ['c', 'n', 'ng', 't']], 'oe': [1, ['n', 't']], 'oo': [0, ['c', 'ng']],
  'uâ': [0, ['n', 'ng', 't']], 'uê': [1, ['ch', 'nh', 'n']], 'uy': [1, ['ch', 'nh', 'n', 'p', 't']], 'uơ': [1, []],
  'ia': [1, []], 'ua': [1, []], 'ưa': [1, []], 'uya': [1, []],
  'iê': [0, C_BACK], 'yê': [0, ['n', 'm', 't', 'ng']], 'uô': [0, ['c', 'm', 'n', 'ng', 't']], 'ươ': [0, C_BACK], 'uyê': [0, ['n', 't']],
};
['ai', 'ao', 'au', 'ay', 'âu', 'ây', 'eo', 'êu', 'iu', 'oi', 'ôi', 'ơi', 'ui', 'ưi', 'ưu', 'iêu', 'yêu', 'oai', 'oay', 'uây', 'uôi', 'ươi', 'ươu', 'uyu', 'oeo']
  .forEach((k) => { NUC[k] = [1, []]; });
const NUC_KEYS = Object.keys(NUC).sort((x, y) => y.length - x.length);
const ONSETS = ['ngh', 'ng', 'nh', 'ch', 'gh', 'gi', 'kh', 'ph', 'qu', 'th', 'tr', 'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x', ''];
const TONES = '̣̀́̃̉';
function validSyllable(syl) {
  let tone = '', base = '';
  for (const ch of String(syl).normalize('NFD')) {
    if (TONES.includes(ch)) { if (tone) return false; tone = ch; } else base += ch;
  }
  base = base.normalize('NFC');
  if (!base || base.length > 7) return false;
  for (const on of ONSETS) {
    if (!base.startsWith(on)) continue;
    const rest = base.slice(on.length);
    for (const nk of NUC_KEYS) {
      if (!rest.startsWith(nk)) continue;
      const [open, codas] = NUC[nk]; const coda = rest.slice(nk.length);
      if (coda === '' ? !open : !codas.includes(coda)) continue;
      const front = /^[iyeê]/.test(nk);
      if ((on === 'k' || on === 'gh' || on === 'ngh') && !front) continue;
      if ((on === 'c' || on === 'ng') && front) continue;
      if (on === 'g' && front && nk[0] !== 'i') continue;
      if (on === 'qu' && nk[0] === 'u') continue;
      if (STOP.includes(coda) && tone !== '́' && tone !== '̣') continue;
      return true;
    }
  }
  return false;
}

function validWord(w) {
  const parts = w.split(' ');
  if (parts.length !== CFG.syllables) return false;
  if (DICT.has(w)) return true;
  if (CFG.dictionaryMode === 'strict') return false;
  return parts.every(validSyllable) && new Set(parts).size === parts.length;
}

// ---------- Bảng vàng (lưu file) ----------
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
let LB = {};
try { LB = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch (_) { LB = {}; }
let lbTimer = null;
function saveLB() {
  clearTimeout(lbTimer);
  lbTimer = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LB_FILE, JSON.stringify(LB, null, 1)); } catch (_) {} }, 1500);
}
const topBoard = (n = 3) => Object.values(LB).sort((a, b) => b.score - a.score).slice(0, n)
  .map((x) => ({ id: x.id, name: x.name, avatar: x.avatar, score: x.score }));

// ---------- Trạng thái game ----------
const S = {
  chain: [], used: new Set(), need: '', wordAt: Date.now(),
  combo: 0, lastOkAt: 0, turns: 0, players: new Set(), hinted: false,
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// ưu tiên từ mà từ đó còn có từ nối tiếp (tránh chuỗi bị kẹt)
const pickLive = (arr) => { const live = arr.filter((w) => BY_FIRST.has(w.split(' ').pop())); return pick(live.length ? live : arr); };

function candidates(syl) { return (BY_FIRST.get(syl) || []).filter((w) => !S.used.has(w)); }
function startWords() {
  const all = [...DICT].filter((w) => !KILL.has(w) && BY_FIRST.has(last(w)) && !S.used.has(w));
  return all.length ? all : [...DICT];
}

function pushEntry(e) {
  S.chain.push(e); S.used.add(e.word);
  if (S.chain.length > 60) S.chain.shift();
  S.need = last(e.word); S.wordAt = Date.now(); S.hinted = false;
}

function newGame(reason) {
  S.chain = []; S.used = new Set(); S.combo = 0; S.lastOkAt = 0;
  if (reason !== 'deadend') { S.turns = 0; S.players = new Set(); } // ván mới thật sự thì đếm lại từ đầu
  const w = pick(startWords()) || 'động từ';
  pushEntry({ word: w, name: 'Hệ thống', id: '_sys', avatar: '', pts: 0, combo: 0, bot: true, t: Date.now() });
  broadcast({ type: 'reset', reason: reason || 'start', ...snapshot() });
}

function snapshot() {
  return {
    cfg: {
      title1: CFG.title1, title2: CFG.title2, kicker: CFG.kicker, subtitle: CFG.subtitle,
      chainShown: CFG.chainShown, voice: CFG.voice, music: CFG.music, sfxVolume: CFG.sfxVolume,
      hintAfterSec: CFG.hintAfterSec, skipAfterSec: CFG.skipAfterSec, welcome: CFG.welcome, demo: DEMO,
    },
    chain: S.chain.slice(-Math.max(CFG.chainShown, 5) - 2),
    need: S.need,
    elapsedMs: Date.now() - S.wordAt,
    stats: { turns: S.turns, players: S.players.size, combo: S.combo },
    board: topBoard(3),
    tiktok: tiktokStatus,
    music: musicState(),
  };
}

// ---------- Nhạc (điều khiển từ /panel, phát ở overlay) ----------
const MUSIC = { enabled: !!CFG.music.enabled, volume: Math.max(0, Math.min(1, Number(CFG.music.volume) || 0.22)), track: 'lofi' };
const LINKS_FILE = path.join(DATA_DIR, 'music-links.json');
let LINKS = []; try { LINKS = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch (_) { LINKS = []; }
const saveLinks = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LINKS_FILE, JSON.stringify(LINKS, null, 1)); } catch (_) {} };
let musicError = '';
function parseYT(u) {
  let x; try { x = new URL(String(u).trim()); } catch (_) { return null; }
  const h = x.hostname.replace(/^(www|m)\./, ''); let id = '';
  if (h === 'youtu.be') id = x.pathname.slice(1).split('/')[0];
  else if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
    if (x.pathname === '/watch') id = x.searchParams.get('v') || '';
    else { const m = /^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(x.pathname); if (m) id = m[2]; }
  } else return null;
  if (!/^[\w-]{11}$/.test(id)) id = '';
  let list = x.searchParams.get('list') || '';
  if (!/^[\w-]{10,60}$/.test(list) || /^RD/.test(list)) list = ''; // list "Mix" (RD...) không nhúng được
  if (list && !x.searchParams.get('v') && !id) id = '';
  const pl = !!list && (!id || x.pathname === '/playlist' || x.searchParams.has('list'));
  if (!id && !list) return null;
  return pl && list ? { key: 'yt:pl:' + list, list, id: '' } : { key: 'yt:' + id, id, list: '' };
}
function fetchYTTitle(link, cb) {
  const target = link.list ? 'https://www.youtube.com/playlist?list=' + link.list : 'https://www.youtube.com/watch?v=' + link.id;
  let done = false; const fin = (t) => { if (!done) { done = true; cb(t); } };
  try {
    const rq = require('https').get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(target), (r) => {
      let b = ''; r.on('data', (c) => { if (b.length < 20000) b += c; });
      r.on('end', () => { try { fin(JSON.parse(b).title); } catch (_) { fin(''); } });
    });
    rq.on('error', () => fin('')); rq.setTimeout(4000, () => { rq.destroy(); fin(''); });
  } catch (_) { fin(''); }
}
const AUDIO_RE = /\.(mp3|ogg|wav|m4a)$/i;
function listMusic() { try { return fs.readdirSync(MUSIC_DIR).filter((f) => AUDIO_RE.test(f)).sort(); } catch (_) { return []; } }
function musicState() {
  const files = listMusic();
  const okTrack = MUSIC.track === 'lofi' || MUSIC.track === '__all__' || files.includes(MUSIC.track) || LINKS.some((l) => l.key === MUSIC.track);
  if (!okTrack) MUSIC.track = 'lofi';
  return { enabled: MUSIC.enabled, volume: MUSIC.volume, track: MUSIC.track, files, links: LINKS, error: musicError };
}
const broadcastMusic = () => broadcast({ type: 'music', music: musicState() });
function safeMusicName(n) {
  const b = path.basename(String(n || '')).normalize('NFC').replace(/[^\p{L}\p{N}._ \-()]/gu, '_').slice(-100);
  return AUDIO_RE.test(b) && !b.startsWith('.') ? b : '';
}
function serveFile(req, res, full) {
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (m) {
      const a = m[1] ? Number(m[1]) : 0, b = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (a > b) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      return fs.createReadStream(full, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (_) {} }
}

// ---------- Xử lý bình luận ----------
function handleComment(u) {
  if (!u || !u.text) return;
  const id = u.id || u.name || 'anon';
  S.players.add(id);
  const text = norm(u.text);
  if (!text) return;
  const parts = text.split(' ');
  if (parts.length !== CFG.syllables) return;
  if (parts[0] !== S.need) return;          // chưa bắt đầu bằng âm tiết yêu cầu
  if (S.used.has(text)) return;              // từ đã dùng
  if (!validWord(text)) return;
  if (CFG.blockDeadEnd !== false && KILL.has(text)) return; // từ cụt làm kẹt chuỗi

  // ĐÚNG - người sớm nhất thắng (Node chạy tuần tự nên không bị 2 người cùng thắng)
  const now = Date.now();
  const elapsed = (now - S.wordAt) / 1000;
  S.combo = (S.lastOkAt && (now - S.lastOkAt) / 1000 <= CFG.comboWindowSec) ? S.combo + 1 : 1;
  S.lastOkAt = now;
  let pts = CFG.basePoints + Math.min(S.combo - 1, 10) * CFG.comboBonus;
  const fast = elapsed <= CFG.speedBonusSec;
  if (fast) pts += CFG.speedBonus;

  const name = u.name || id;
  if (!LB[id]) LB[id] = { id, name, avatar: u.avatar || '', score: 0 };
  LB[id].name = name; if (u.avatar) LB[id].avatar = u.avatar; LB[id].score += pts;
  saveLB();

  S.turns++;
  const entry = { word: text, name, id, avatar: u.avatar || '', pts, combo: S.combo, fast, t: now, took: +elapsed.toFixed(1) };
  pushEntry(entry);
  const dead = CFG.dictionaryMode === 'strict' && candidates(S.need).length === 0;
  broadcast({ type: 'correct', entry, ...snapshot() });
  console.log(`✔ ${name}: "${text}" +${pts} (combo ${S.combo}, ${elapsed.toFixed(1)}s) → cần "${S.need}"`);
  if (dead) setTimeout(() => newGame('deadend'), 2500);
}

// ---------- Gợi ý / bỏ qua khi không ai trả lời ----------
function maskHint(w) {
  const second = w.split(' ').slice(1).join(' ');
  return second.charAt(0) + second.slice(1).replace(/[^\s]/g, '_ ').trim();
}
setInterval(() => {
  const sec = (Date.now() - S.wordAt) / 1000;
  if (!S.hinted && sec >= CFG.hintAfterSec) {
    const c = candidates(S.need);
    S.hinted = true;
    if (c.length) {
      const w = pickLive(c);
      broadcast({ type: 'hint', text: `${S.need} ${maskHint(w)}`, firstLetter: w.split(' ')[1].charAt(0) });
    }
  }
  if (sec >= CFG.skipAfterSec) {
    const c = candidates(S.need);
    if (!c.length) return newGame('deadend');
    const w = pickLive(c);
    S.combo = 0;
    pushEntry({ word: w, name: 'Hệ thống', id: '_sys', avatar: '', pts: 0, combo: 0, bot: true, t: Date.now() });
    broadcast({ type: 'skip', word: w, ...snapshot() });
  }
}, 1000);

// ---------- TikTok Live ----------
let tiktokStatus = DEMO ? 'demo' : 'idle';
function pickAvatar(d) {
  const u = d.user || d;
  const cands = [
    d.profilePictureUrl, u.profilePictureUrl,
    u.profilePicture && (u.profilePicture.url || (u.profilePicture.urls && u.profilePicture.urls[0])),
    u.avatarThumb && u.avatarThumb.urlListList && u.avatarThumb.urlListList[0],
    u.avatarMedium && u.avatarMedium.urlListList && u.avatarMedium.urlListList[0],
  ];
  const v = cands.find((x) => typeof x === 'string' && x);
  return v || '';
}
const who = (d) => {
  const u = d.user || d;
  return { id: d.uniqueId || u.uniqueId || u.userId || d.userId, name: d.nickname || u.nickname || d.uniqueId || u.uniqueId, avatar: pickAvatar(d) };
};

function connectTikTok() {
  const username = String(CFG.tiktokUsername || '').replace(/^@/, '').trim();
  if (!username) { console.warn('⚠ Chưa điền "tiktokUsername" trong config.json. Chạy với tham số "demo" để thử.'); return; }
  let lib;
  try { lib = require('tiktok-live-connector'); }
  catch (e) { console.error('✖ Chưa cài tiktok-live-connector. Chạy: npm install'); return; }

  const E = lib.WebcastEvent || {};
  const evChat = E.CHAT || 'chat', evMember = E.MEMBER || 'member', evGift = E.GIFT || 'gift';
  const Conn = lib.TikTokLiveConnection || lib.WebcastPushConnection;
  const conn = new Conn(username);

  conn.on(evChat, (d) => { const w = who(d); handleComment({ ...w, text: d.comment }); });
  conn.on(evMember, (d) => { const w = who(d); broadcast({ type: 'join', name: w.name, avatar: w.avatar }); });
  conn.on(evGift, (d) => {
    if (d.giftType === 1 && d.repeatEnd === false) return; // bỏ qua quà đang combo
    const w = who(d);
    broadcast({ type: 'gift', name: w.name, avatar: w.avatar, gift: d.giftName || (d.giftDetails && d.giftDetails.giftName) || 'quà', count: d.repeatCount || 1 });
  });

  const retry = (why) => {
    tiktokStatus = 'reconnecting'; broadcast({ type: 'status', status: tiktokStatus });
    console.warn('[tiktok] mất kết nối (' + why + '), thử lại sau 10s...');
    setTimeout(go, 10000);
  };
  const go = () => {
    tiktokStatus = 'connecting'; broadcast({ type: 'status', status: tiktokStatus });
    Promise.resolve(conn.connect()).then(() => {
      tiktokStatus = 'connected'; broadcast({ type: 'status', status: tiktokStatus });
      console.log('✔ Đã kết nối live của @' + username);
    }).catch((e) => retry(e && e.message || e));
  };
  conn.on(E.DISCONNECTED || 'disconnected', () => retry('disconnected'));
  conn.on(E.STREAM_END || 'streamEnd', () => { tiktokStatus = 'ended'; broadcast({ type: 'status', status: tiktokStatus }); });
  conn.on('error', (e) => console.warn('[tiktok] lỗi:', e && e.message || e));
  go();
}

// ---------- Demo ----------
function runDemo() {
  const fake = ['Minh Anh', 'Hùng Cường', 'Lan Hương', 'Bống 🐟', 'Tuấn Kiệt', 'Mèo Béo', 'Thoong249', 'Gia Sư'];
  const joinNames = ['Ngọc Trâm', 'Bảo Long', 'Hải Yến'];
  setInterval(() => {
    if (Math.random() < 0.25) handleComment({ id: 'f' + Math.random(), name: pick(fake), text: pick(['hello', 'nối từ gì vậy', 'động đất', 'xin chào']) });
    const c = candidates(S.need);
    if (c.length && Math.random() < 0.55) {
      const n = pick(fake);
      handleComment({ id: 'demo_' + n, name: n, avatar: '', text: pickLive(c) });
    }
  }, 4500);
  setInterval(() => broadcast({ type: 'join', name: pick(joinNames), avatar: '' }), 17000);
  setInterval(() => broadcast({ type: 'gift', name: pick(fake), avatar: '', gift: 'Hoa hồng', count: 1 }), 41000);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Các lệnh điều khiển cần ?key=ADMIN_TOKEN khi đã đặt ADMIN_TOKEN
  const isAdmin = p === '/panel' || (p.startsWith('/api/') && p !== '/api/state' && p !== '/api/music/report');
  if (ADMIN_TOKEN && isAdmin && url.searchParams.get('key') !== ADMIN_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Cần thêm ?key=MẬT_KHẨU vào đường dẫn.');
  }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'state', ...snapshot() })}\n\n`);
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (p === '/api/state') return json(res, snapshot());
  if (p === '/api/music') return json(res, musicState());
  if (p === '/api/music/set') {
    const q = url.searchParams;
    if (q.has('enabled')) MUSIC.enabled = q.get('enabled') === '1';
    if (q.has('volume')) MUSIC.volume = Math.max(0, Math.min(1, Number(q.get('volume')) || 0));
    if (q.has('track')) { MUSIC.track = q.get('track'); musicError = ''; }
    broadcastMusic(); return json(res, musicState());
  }
  if (p === '/api/music/addlink') {
    const link = parseYT(url.searchParams.get('url'));
    if (!link) return json(res, { error: 'Link YouTube không hợp lệ (dán link video hoặc playlist).' }, 400);
    return fetchYTTitle(link, (title) => {
      const entry = { key: link.key, id: link.id, list: link.list, title: title || (link.list ? 'Playlist ' + link.list : 'youtu.be/' + link.id) };
      const i = LINKS.findIndex((l) => l.key === entry.key); if (i >= 0) LINKS[i] = entry; else LINKS.push(entry);
      if (LINKS.length > 50) LINKS.shift();
      saveLinks(); MUSIC.track = entry.key; MUSIC.enabled = true; musicError = '';
      broadcastMusic(); json(res, musicState());
    });
  }
  if (p === '/api/music/dellink') {
    const k = url.searchParams.get('key'); LINKS = LINKS.filter((l) => l.key !== k); saveLinks();
    broadcastMusic(); return json(res, musicState());
  }
  if (p === '/api/music/report') { // overlay báo lỗi phát (vd: video cấm nhúng)
    musicError = String(url.searchParams.get('msg') || '').slice(0, 200);
    if (musicError) { MUSIC.track = 'lofi'; console.warn('[music] ' + musicError); }
    broadcastMusic(); return json(res, { ok: true });
  }
  if (p === '/api/music/delete') {
    const name = safeMusicName(url.searchParams.get('name'));
    if (name) { try { fs.unlinkSync(path.join(MUSIC_DIR, name)); } catch (_) {} }
    broadcastMusic(); return json(res, musicState());
  }
  if (p === '/api/music/upload' && req.method === 'POST') {
    const name = safeMusicName(url.searchParams.get('name'));
    if (!name) { req.resume(); return json(res, { error: 'Chỉ nhận file mp3, ogg, wav, m4a.' }, 400); }
    try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (e) { req.resume(); return json(res, { error: 'Không tạo được thư mục nhạc.' }, 500); }
    const tmp = path.join(MUSIC_DIR, '.up-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
    const ws = fs.createWriteStream(tmp); let size = 0, tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD && !tooBig) { tooBig = true; req.unpipe(ws); ws.destroy(); req.resume(); } });
    req.pipe(ws);
    ws.on('error', () => { fs.unlink(tmp, () => {}); if (!res.headersSent) json(res, { error: 'Lỗi ghi file.' }, 500); });
    req.on('end', () => {
      if (tooBig) { fs.unlink(tmp, () => {}); return json(res, { error: 'File quá lớn (tối đa 30MB).' }, 413); }
      ws.on('finish', () => {
        try { fs.renameSync(tmp, path.join(MUSIC_DIR, name)); } catch (e) { return json(res, { error: 'Lỗi lưu file.' }, 500); }
        broadcastMusic(); json(res, { ok: true, name });
      });
    });
    return;
  }
  if (p.startsWith('/music/')) {
    let n = ''; try { n = decodeURIComponent(p.slice(7)); } catch (_) {}
    const name = path.basename(n);
    if (!name || !AUDIO_RE.test(name)) { res.writeHead(404); return res.end('Not found'); }
    return serveFile(req, res, path.join(MUSIC_DIR, name));
  }
  if (p === '/api/reset') { newGame('manual'); return json(res, { ok: true }); }
  if (p === '/api/skip') {
    const c = candidates(S.need);
    if (!c.length) { newGame('deadend'); return json(res, { ok: true, reset: true }); }
    const w = pickLive(c); S.combo = 0;
    pushEntry({ word: w, name: 'Hệ thống', id: '_sys', avatar: '', pts: 0, combo: 0, bot: true, t: Date.now() });
    broadcast({ type: 'skip', word: w, ...snapshot() });
    return json(res, { ok: true, word: w });
  }
  if (p === '/api/clear-board') { LB = {}; saveLB(); broadcast({ type: 'state', ...snapshot() }); return json(res, { ok: true }); }
  if (p === '/api/test') { // thử nhanh: /api/test?user=An&text=từ%20điển
    handleComment({ id: url.searchParams.get('user') || 'tester', name: url.searchParams.get('user') || 'Tester', avatar: url.searchParams.get('avatar') || '', text: url.searchParams.get('text') || '' });
    return json(res, { ok: true, need: S.need });
  }

  // static
  let f = p === '/' ? '/index.html' : p === '/panel' ? '/panel.html' : p;
  const full = path.normalize(path.join(PUBLIC, f));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// Chống Render "ngủ": tự gọi vào địa chỉ công khai mỗi 4 phút
const SELF_URL = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
if (SELF_URL && process.env.KEEPALIVE !== 'off') {
  const ping = () => {
    try {
      const u = new URL('/healthz', SELF_URL);
      (u.protocol === 'https:' ? require('https') : require('http')).get(u, (r) => r.resume()).on('error', () => {}).setTimeout(10000, function () { this.destroy(); });
    } catch (_) {}
  };
  setInterval(ping, 4 * 60 * 1000);
  console.log('[keepalive] tự ping ' + SELF_URL + ' mỗi 4 phút');
}

server.listen(CFG.port, CFG.host, () => {
  console.log('────────────────────────────────────────────');
  console.log(' NỐI TỪ ĐẠI CHIẾN' + (DEMO ? '  [CHẾ ĐỘ DEMO]' : ''));
  console.log(` Overlay : http://localhost:${CFG.port}/`);
  console.log(` Điều khiển: http://localhost:${CFG.port}/panel`);
  console.log('────────────────────────────────────────────');
  newGame('start');
  if (DEMO) runDemo(); else connectTikTok();
});
