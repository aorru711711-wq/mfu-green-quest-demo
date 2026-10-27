/* MFU Green Quest - Progress 2 prototype (AI BRO 67)
   Plain JavaScript, no build step. Data stays in this browser (localStorage).
   Photos are never written to localStorage or anywhere else; they live only
   in memory until the answer comes back, then they are cleared. */
'use strict';

const API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'; // fastest + cheapest in our test, 9/9 correct
const BACKUP_MODEL = 'gemini-3.8-flash';       // used once if the main model is busy (503/429) or too slow
const THINKING = { 'gemini-3.5-flash-lite': 'minimal', 'gemini-3.8-flash': 'low' }; // lowest each model accepts (3.8 Flash rejects "minimal")
const MAIN_WAIT_MS = 12000, BACKUP_WAIT_MS = 20000; // abort a stuck call instead of making the student wait
const DAILY_XP_LIMIT = 100;
const XP_PER_SORT = 10;
const MAX_SIDE = 384;            // long side in px. Smaller upload; accuracy was the same as 512/768 in our test
const JPEG_Q = 0.6;
const IMG_RES = 'low';           // Gemini 3 media resolution: ~260 image tokens instead of ~1,120 (default)
const LS = 'mgq_v1';             // localStorage key

const BINS = {
  recyclable: { colour: 'YELLOW', label: 'Recyclable waste', hex: '#fdd835', icon: '♻️' },
  organic:    { colour: 'GREEN',  label: 'Organic (wet) waste', hex: '#43a047', icon: '🍃' },
  general:    { colour: 'BLUE',   label: 'General waste', hex: '#1e88e5', icon: '🗑️' },
  hazardous:  { colour: 'RED',    label: 'Hazardous waste', hex: '#e53935', icon: '⚠️' }
};

// Example data only, used to show how the leaderboard works.
const EXAMPLE_DORMS = { 'Dorm A': 3210, 'Dorm B': 2180, 'Dorm C': 2750, 'Dorm D': 1430, 'Dorm E': 1760, 'Dorm F': 2515 };

const QUESTS = [
  { id: 'recycle3', name: '♻️ Sort 3 recyclable items', target: 3, bonus: 30 },
  { id: 'split1',   name: '🥤 Split an item with many parts', target: 1, bonus: 20 },
  { id: 'organic1', name: '🍃 Sort organic waste', target: 1, bonus: 15 }
];

/* ---------- prompt (short version, tuned 27 Oct 2026) ---------- */
// Short field names keep the answer small; toLong() maps them back for the rest of the app.
const SYSTEM_PROMPT = `Sort waste for students at a university in Chiang Rai, Thailand. Thai bins:
recyclable (yellow): clean PET bottles, cans, glass, clean paper/cardboard, clean plastic cups and lids.
organic (green): food scraps, peels, leftover rice, banana leaves, plants.
general (blue): dirty or mixed packaging, foam boxes, snack/candy wrappers and foil-plastic film, straws, tissues, plastic-lined paper cups.
hazardous (red): batteries, bulbs, spray cans, chemicals, medicine, electronics.
Rules: split the item into parts, one bin per part. Liquids: say pour out first. Dirty recyclables: rinse, else general.
c: high only if item and material are clear; low if blurry/dark/unclear (then use general).
p: true only if a human face, head or body is visible. Hands or fingers holding the item: false.
w: false if no trash is shown.
t and y: short generic sorting and prep advice only. Never say whether something can or cannot be recycled at a place (locally, here, MFU, campus).`;

const BIN_KEYS = ['recyclable', 'organic', 'general', 'hazardous'];
const SCHEMA = {
  type: 'object',
  properties: {
    i: { type: 'string', description: 'item name' },
    w: { type: 'boolean', description: 'is waste' },
    p: { type: 'boolean', description: 'person visible' },
    s: { type: 'array', items: { type: 'object', properties: {
          n: { type: 'string', description: 'part name' },
          b: { type: 'string', enum: BIN_KEYS },
          x: { type: 'string', description: 'prep step or empty' } }, required: ['n', 'b', 'x'] } },
    c: { type: 'string', enum: ['high', 'medium', 'low'] },
    t: { type: 'string', description: 'tip, max 15 words' },
    y: { type: 'string', description: 'why, max 25 words' }
  },
  required: ['i', 'w', 'p', 's', 'c', 't', 'y']
};
function toLong(a) {
  if (!a || typeof a !== 'object') throw new Error('bad answer');
  return { item: a.i, is_waste_item: a.w !== false, person_visible: a.p === true,
    parts: (Array.isArray(a.s) ? a.s : []).map((q) => ({ name: q && q.n, bin: q && q.b, prep: (q && q.x) || '' })),
    confidence: a.c, tip: a.t || '', why: a.y || '' };
}

/* ---------- demo answers (sample data, NOT from Gemini) ---------- */
const DEMO = {
  bottle: { item: 'Plastic water bottle', is_waste_item: true, person_visible: false, confidence: 'high',
    parts: [{ name: 'Bottle', material: 'PET plastic', bin: 'recyclable', prep: 'Pour out any water and squeeze it flat' },
            { name: 'Cap', material: 'PP plastic', bin: 'recyclable', prep: 'Put the cap back on the bottle' }],
    tip: 'Empty it, squeeze it flat, put the cap back on.',
    why: 'Clean PET bottles can be recycled. Drink left inside can make other recyclables dirty.' },
  cup: { item: 'Iced-tea cup with lid and straw', is_waste_item: true, person_visible: false, confidence: 'medium',
    parts: [{ name: 'Leftover tea and ice', material: 'liquid', bin: 'general', prep: 'Pour into a sink or drain first, not into the bin' },
            { name: 'Cup', material: 'PP or PET plastic', bin: 'recyclable', prep: 'Quick rinse if it is sticky' },
            { name: 'Lid', material: 'plastic', bin: 'recyclable', prep: '' },
            { name: 'Straw', material: 'plastic', bin: 'general', prep: '' }],
    tip: 'Pour out the ice first, then split the cup, lid and straw.',
    why: 'Cups and lids can be recycled when they are clean. Straws are too small to recycle, so they go in general waste.' },
  leaf: { item: 'Banana-leaf wrapper (Khao Tom Mad)', is_waste_item: true, person_visible: false, confidence: 'high',
    parts: [{ name: 'Banana leaf with rice', material: 'plant / food', bin: 'organic', prep: '' },
            { name: 'Plastic string', material: 'plastic', bin: 'general', prep: 'Take it off the leaf first' }],
    tip: 'Remove the plastic string, then the leaf goes in organic.',
    why: 'Banana leaf and rice break down naturally. The plastic string does not, so it must be taken off.' },
  blurry: { item: 'Unclear item', is_waste_item: true, person_visible: false, confidence: 'low',
    parts: [{ name: 'Unknown', material: 'unknown', bin: 'general', prep: '' }],
    tip: 'Take the photo again with better light.',
    why: 'The photo is too blurry to see the material, so the safe choice is general waste.' }
};

/* ---------- state ---------- */
const today = () => new Date().toISOString().slice(0, 10);
function weekKey(d = new Date()) {           // Monday of this week
  const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}
function load() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { s = {}; }
  s.profile = s.profile || null;
  s.settings = Object.assign({ key: '', model: DEFAULT_MODEL, lang: 'English', demo: false, demoSample: 'bottle' }, s.settings || {});
  if (!s.settings.v2) { s.settings.model = DEFAULT_MODEL; s.settings.v2 = true; } // move old installs to the new default
  s.totalXP = s.totalXP || 0;
  s.sorts = s.sorts || 0;
  s.reports = s.reports || [];
  if (!s.day || s.day.date !== today()) s.day = { date: today(), xp: 0, quests: {} };
  if (!s.week || s.week.start !== weekKey()) s.week = { start: weekKey(), xp: 0, sorts: 0 };
  return s;
}
let S = load();
const save = () => localStorage.setItem(LS, JSON.stringify(S));

// photo lives here only (memory), never saved
let photo = null;      // { base64, mime, url }
let current = null;    // last answer
let confirmed = false;

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200); }

function go(name) {
  if (!S.profile && name !== 'consent') name = 'consent';
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
  $('s-' + name).classList.add('on');
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === name || (name === 'result' && b.dataset.go === 'scan')));
  document.body.classList.toggle('noconsent', !S.profile);
  if (name === 'home') renderHome();
  if (name === 'board') renderBoard();
  if (name === 'settings') renderSettings();
  if (name === 'scan') renderScan();
  window.scrollTo(0, 0);
  location.hash = name;
}

/* ---------- consent ---------- */
function initConsent() {
  $('dorm').innerHTML = Object.keys(EXAMPLE_DORMS).map((d) => `<option>${d}</option>`).join('');
  const check = () => { $('btn-consent').disabled = !($('agree').checked && $('nick').value.trim()); };
  $('agree').onchange = check; $('nick').oninput = check;
  $('btn-consent').onclick = () => {
    S.profile = { nick: $('nick').value.trim().slice(0, 16), dorm: $('dorm').value, consentAt: new Date().toISOString() };
    save(); toast('Welcome, ' + S.profile.nick + '!'); go('home');
  };
}

/* ---------- home ---------- */
function dormTable() {
  const t = Object.assign({}, EXAMPLE_DORMS);
  if (S.profile) t[S.profile.dorm] = (t[S.profile.dorm] || 0) + S.week.xp;
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
}
function renderHome() {
  $('hello').textContent = 'Hi, ' + S.profile.nick + ' 👋';
  const lvl = Math.floor(S.totalXP / 100) + 1, inLvl = S.totalXP % 100;
  $('lvl').textContent = 'Nong Hom · Level ' + lvl;
  $('xptext').textContent = inLvl + ' / 100 Eco-XP (total ' + S.totalXP + ')';
  $('xpbar').style.width = inLvl + '%';
  $('mydorm').textContent = S.profile.dorm;
  $('myrank').textContent = '#' + (dormTable().findIndex((r) => r[0] === S.profile.dorm) + 1);
  $('quests').innerHTML = QUESTS.map((q) => {
    const n = Math.min(S.day.quests[q.id] || 0, q.target), done = n >= q.target;
    return `<div class="card quest"><div class="row"><b>${q.name}</b><span class="xp">+${q.bonus} XP</span></div>
      <div class="bar"><i style="width:${(n / q.target) * 100}%"></i></div>
      <div class="${done ? 'done' : 'small'}" style="margin-top:4px">${done ? 'Completed ✓' : n + ' / ' + q.target + ' done'}</div></div>`;
  }).join('');
  $('todayxp').textContent = 'Today: ' + S.day.xp + ' / ' + DAILY_XP_LIMIT + ' XP (daily limit, to keep it fair)';
}

/* ---------- scan ---------- */
function renderScan() {
  $('btn-analyze').disabled = !photo;
  $('btn-analyze').textContent = S.settings.demo ? 'Which bin? (DEMO answer)' : 'Which bin? ✨';
}
function clearPhoto() {
  if (photo && photo.url) URL.revokeObjectURL(photo.url);
  photo = null; $('file').value = '';
  $('preview').hidden = true; $('preview').removeAttribute('src'); $('ph').hidden = false;
}
function showErr(msg) { const e = $('scanerr'); e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }

async function readPhoto(file) {
  // Draw on a canvas to resize and re-encode as JPEG. This also drops EXIF data (e.g. GPS location).
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', JPEG_Q);
  return { base64: dataUrl.split(',')[1], mime: 'image/jpeg', url, w: c.width, h: c.height };
}

async function onFile(ev) {
  const f = ev.target.files && ev.target.files[0];
  showErr('');
  if (!f) return;
  if (!f.type.startsWith('image/')) { showErr('Please choose an image file.'); return; }
  try {
    clearPhoto(); renderScan();          // button off while the new photo loads
    photo = await readPhoto(f);
    $('preview').src = photo.url; $('preview').hidden = false; $('ph').hidden = true;
  } catch (e) { showErr('Could not read this photo. Try another one.'); photo = null; }
  renderScan();
}

function buildRequest(p, model) {
  return {
    model: model,
    system_instruction: SYSTEM_PROMPT,
    input: [
      { type: 'text', text: `Which bin? ${S.settings.lang}. JSON only.` },
      { type: 'image', data: p.base64, mime_type: p.mime, resolution: IMG_RES }
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
    // No temperature: Google says to keep the Gemini 3 default (newer models ignore it).
    // 3.8 Flash rejects "minimal", so the backup is always "low".
    generation_config: { thinking_level: model === BACKUP_MODEL ? 'low' : (THINKING[model] || 'low'), max_output_tokens: 300 },
    store: false   // ask Google not to keep this interaction
  };
}

function extractText(data) {
  // Interactions API: steps[] -> model_output -> content[] -> text. Older shape: outputs[].text
  if (Array.isArray(data)) data = data[0];
  if (data && Array.isArray(data.steps)) {
    const outs = data.steps.filter((s) => s.type === 'model_output');
    const last = outs[outs.length - 1];
    if (last && last.content) return last.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  if (data && Array.isArray(data.outputs)) return data.outputs.filter((o) => o.type === 'text').map((o) => o.text).join('');
  if (data && data.output_text) return data.output_text;
  return '';
}

// Safety net: small models still write "cannot be recycled locally" or "MFU does not recycle this".
// Drop that whole sentence. Deleting only the place word left "Foam cannot be recycled." or broken grammar.
// "here" is a place only in "recycled here", "here at/on/in", "around here", "can't … here" — not "Here is a tip".
const HERE_PLACE = /\brecycl(?:e|ed|able)\s+here\b|\b(?:accepted|collected|sorted)\s+here\b|\bhere\s+(?:at|on|in)\b|\baround\s+here\b|\b(?:not|can't|cannot|isn't|doesn't)\b(?:\s+\S+){0,5}\s+here\b/i;
const PLACE_CLAIM = /\blocally\b|\bin this area\b|\bon campus\b|\bMae Fah Luang\b|\bMFU\b|\b(?:this|our|the|at)\s+(?:campus|university)\b(?!\s+bins?\b)/i;
function splitSentences(text) {
  const out = [];
  let cur = '';
  let afterSemi = false;
  const push = (endSemi) => {
    const s = cur.trim();
    cur = '';
    if (!s) { if (endSemi) afterSemi = true; return; }
    out.push({ s, semi: afterSemi || endSemi });
    afterSemi = endSemi;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ';' || c === '\n') { push(c === ';'); continue; }
    cur += c;
    const next = text[i + 1];
    // . ! ? end a sentence only before a space or the end, and not after "e.g." / "i.e."
    if ((c === '.' || c === '!' || c === '?') && (next == null || /\s/.test(next)) && !/(?:^|\s)(?:e\.g|i\.e)\.$/i.test(cur)) push(false);
  }
  push(false);
  return out;
}
function dropPlaceSentences(text) {
  if (typeof text !== 'string') return '';
  const kept = [];
  for (const bit of splitSentences(text)) {
    if (/^[\s.!?;,'"()[\]-]*$/.test(bit.s) || PLACE_CLAIM.test(bit.s) || HERE_PLACE.test(bit.s)) continue;
    let s = bit.s;
    const i = s.search(/[A-Za-z]/);
    if (i >= 0 && s[i] >= 'a' && s[i] <= 'z') s = s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
    if (bit.semi && !/[.!?]['")\]]*$/.test(s)) s += '.';
    kept.push(s);
  }
  return kept.join(' ').trim();
}
function prepFallback(parts) {
  const p = Array.isArray(parts) ? parts[0] : null;
  const prep = p && typeof p.prep === 'string' ? p.prep.trim() : '';
  if (!prep || /^(none|n\/a|-)\.?$/i.test(prep)) return '';
  return dropPlaceSentences(prep);
}
function whyFallback(a) {
  // A blank why is safer than inventing a bin for "not trash" or a low-confidence retake.
  if (!a || a.confidence === 'low' || a.is_waste_item === false) return '';
  const bin = a.parts && a.parts[0] && BINS[a.parts[0].bin];
  return bin ? 'It goes in the ' + bin.colour.toLowerCase() + ' bin (' + bin.label.toLowerCase() + ').' : '';
}
function validate(a) {
  if (!a || typeof a !== 'object') throw new Error('bad answer');
  if (!Array.isArray(a.parts)) a.parts = [];
  a.parts = a.parts.filter((p) => p && BINS[p.bin]);
  if (!a.parts.length) a.parts = [{ name: a.item || 'Item', bin: 'general', prep: '' }];
  if (!['high', 'medium', 'low'].includes(a.confidence)) a.confidence = 'low';
  const tip = dropPlaceSentences(a.tip);
  a.tip = tip || prepFallback(a.parts) || 'Check the bin colour before you throw it.';
  const why = dropPlaceSentences(a.why);
  a.why = why || whyFallback(a);
  return a;
}

function abortError(ctrl) {
  // Use the abort reason when it is an Error. A string reason would crash the message checks later.
  const reason = ctrl && ctrl.signal.reason;
  if (reason && typeof reason === 'object' && reason.name) return reason;
  const e = new Error('timeout');
  e.name = 'AbortError';
  return e;
}
function shouldBackup(e) {
  // One retry: the main model is busy, offline, aborted, or its JSON was empty/cut off.
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'TypeError' || e.network) return true;
  if (e.badJson || e instanceof SyntaxError || e.message === 'bad answer') return true;
  return [429, 500, 503].includes(e.status);
}
async function askGemini(p, model, waitMs = BACKUP_WAIT_MS) {
  const key = S.settings.key.trim();
  if (!key) throw new Error('NO_KEY');
  const t0 = performance.now();
  const ctrl = new AbortController();
  // Cover the body too. Clearing this when headers arrive let a slow res.json() hang.
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'AbortError')), waitMs);
  try {
    let res;
    try {
      res = await fetch(API_URL, { method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(buildRequest(p, model)) });
    } catch (e) {
      if (ctrl.signal.aborted) throw abortError(ctrl);
      if (e && e.name === 'TypeError') e.network = true; // fetch() failed before any HTTP status
      throw e;
    }
    let data = null;
    try { data = await res.json(); }
    catch (e) {
      if (ctrl.signal.aborted) throw abortError(ctrl); // a cut-off body is a timeout, not bad JSON
      data = null;
    }
    if (ctrl.signal.aborted) throw abortError(ctrl);
    if (!res.ok) {
      const err = (Array.isArray(data) ? data[0] : data)?.error;
      const e = new Error('API ' + res.status + ': ' + (err?.message || 'request failed'));
      e.status = res.status; throw e;
    }
    const raw = extractText(data);
    window._lastRaw = raw;          // memory only, for debugging; never saved
    let answer;
    try { answer = validate(toLong(JSON.parse(raw))); }
    catch (e) {
      if (!(e instanceof SyntaxError) && (!e || e.message !== 'bad answer')) throw e;
      const err = new SyntaxError('bad answer'); // empty or truncated JSON: backup gets one try
      err.badJson = true; throw err;
    }
    answer._model = model; answer._ms = Math.round(performance.now() - t0);
    answer._usage = data && data.usage ? { input: data.usage.total_input_tokens, output: data.usage.total_output_tokens, thought: data.usage.total_thought_tokens } : null;
    return answer;
  } finally { clearTimeout(timer); }
}

async function askWithBackup(p) {
  const main = S.settings.model || DEFAULT_MODEL;
  try {
    return await askGemini(p, main, main === BACKUP_MODEL ? BACKUP_WAIT_MS : MAIN_WAIT_MS);
  } catch (e) {
    if (!shouldBackup(e) || main === BACKUP_MODEL) throw e;
    $('busytext').textContent = 'Busy, trying backup AI...';
    try {
      const answer = await askGemini(p, BACKUP_MODEL, BACKUP_WAIT_MS);
      answer._model = BACKUP_MODEL; // show the model that answered, not the one that failed
      return answer;
    } finally {
      $('busytext').textContent = ''; // don't leave "trying backup" up after it returns
    }
  }
}

let inFlight = false;   // one request at a time: double taps do not send a second call
async function analyze() {
  if (!photo || inFlight) return;
  inFlight = true;
  showErr(''); document.body.classList.add('busy'); $('s-scan').classList.add('busy'); $('btn-analyze').disabled = true;
  $('btn-analyze').textContent = 'Checking...'; $('busytext').textContent = 'Asking Gemini (usually 1-2 s)';
  try {
    let answer;
    if (S.settings.demo) {
      await new Promise((r) => setTimeout(r, 700));
      answer = JSON.parse(JSON.stringify(DEMO[S.settings.demoSample] || DEMO.bottle));
      answer._demo = true;
    } else {
      answer = await askWithBackup(photo);
    }
    current = answer; confirmed = false;
    clearPhoto();                           // photo is gone after the answer
    renderResult(); go('result');
  } catch (e) {
    const m = e && typeof e.message === 'string' ? e.message : '';
    let msg = 'Something went wrong. Please try again.';
    if (m === 'NO_KEY') msg = 'No API key yet. Add your free Gemini key in Settings (Me), or turn on Demo mode.';
    else if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) msg = 'Gemini took too long. Check your internet and try again.';
    else if (m.startsWith('API')) msg = 'Gemini error: ' + m.slice(0, 160);
    else if (e instanceof SyntaxError || m === 'bad answer') msg = 'The AI answer was not in the right format. Please scan again.';
    showErr(msg);
  } finally {
    inFlight = false; $('busytext').textContent = '';
    document.body.classList.remove('busy'); $('s-scan').classList.remove('busy'); renderScan();
  }
}

/* ---------- result ---------- */
function binSvg(hex) {
  return `<svg width="62" height="76" viewBox="0 0 70 84"><rect x="4" y="10" width="62" height="10" rx="3" fill="${hex}" stroke="#333" stroke-width="2" /><path d="M9 20 L61 20 L56 80 L14 80Z" fill="${hex}" stroke="#333" stroke-width="2" /><path d="M24 34 V70 M35 34 V70 M46 34 V70" stroke="rgba(0,0,0,.35)" stroke-width="3" /></svg>`;
}
function renderResult() {
  const a = current, box = $('resultbody');
  const demoTag = a._demo ? '<p class="center" style="margin:4px 0"><span class="tag" style="background:#fff3cd;color:#6b4e00">DEMO answer (sample data, not Gemini)</span></p>' : '';
  if (a.person_visible) {
    box.innerHTML = demoTag + `<div class="card low"><b>🙈 A person is in the photo</b><p class="small" style="margin-top:4px">For privacy, please take the photo again with only the trash in it.</p></div>
      <button class="btn" data-go="scan">📷 Take another photo</button>`;
    return;
  }
  if (!a.is_waste_item) {
    box.innerHTML = demoTag + `<div class="card low"><b>🤔 This doesn't look like trash</b><p class="small" style="margin-top:4px">${esc(a.why)}</p></div>
      <button class="btn" data-go="scan">📷 Try another photo</button>`;
    return;
  }
  if (a.confidence === 'low') {
    box.innerHTML = demoTag + `<div class="card low"><b>📷 I'm not sure about this one</b>
      <p class="small" style="margin-top:4px">${esc(a.why)}</p><p class="small" style="margin-top:6px">Please take another photo: closer, with more light, item only.</p></div>
      <div class="binbox b-general">${binSvg(BINS.general.hex)}<div><div class="small" style="color:inherit">If you can't retake it, the safe choice is the</div><div class="big">BLUE bin</div><div>General waste</div></div></div>
      <button class="btn" data-go="scan">📷 Take another photo</button>
      <p class="small center">No XP for unsure answers, so the points stay fair.</p>`;
    return;
  }
  const main = a.parts.find((p) => p.bin !== 'general') || a.parts[0];
  const B = BINS[main.bin];
  const multi = a.parts.length > 1;
  box.innerHTML = demoTag + `
   <div class="card"><b>${esc(a.item)}</b><div class="small">Confidence: ${esc(a.confidence)}${a.confidence === 'medium' ? ' (please double-check)' : ''}${a._model ? ' · AI: ' + esc(a._model) : ''}</div></div>
   <div class="binbox b-${main.bin}">${binSvg(B.hex)}<div><div class="small" style="color:inherit">${multi ? 'Main part goes in the' : 'Put it in the'}</div><div class="big">${B.colour} bin</div><div>${B.label}</div></div></div>
   <div class="card"><b>${multi ? 'Each part' : 'Before you throw it'}</b><ul class="partlist" style="margin-top:4px">
    ${a.parts.map((p) => `<li><span class="dot" style="background:${BINS[p.bin].hex}"></span><span><b>${esc(p.name)}</b> → ${BINS[p.bin].colour.toLowerCase()} bin (${BINS[p.bin].label.toLowerCase()})${p.prep && !/^(none|n\/a|-)\.?$/i.test(p.prep.trim()) ? '<br><span class="small">' + esc(p.prep) + '</span>' : ''}</span></li>`).join('')}
   </ul><p class="small" style="margin-top:6px">💡 ${esc(a.tip)}</p></div>
   <div class="card why"><b>Why this bin?</b><p class="small" style="margin-top:4px;color:#333">${esc(a.why)}</p></div>
   <button class="btn" id="btn-threw">✅ I threw it in · +${XP_PER_SORT} XP</button>
   <button class="link" id="btn-report">⚠️ Report wrong answer</button>`;
  $('btn-threw').onclick = confirmSort;
  $('btn-report').onclick = report;
}

function addXP(n) {
  const room = Math.max(0, DAILY_XP_LIMIT - S.day.xp), got = Math.min(n, room);
  S.day.xp += got; S.week.xp += got; S.totalXP += got;
  return got;
}
function confirmSort() {
  if (confirmed || !current) return;
  confirmed = true;
  const a = current; let got = addXP(XP_PER_SORT); const msgs = [];
  S.sorts++; S.week.sorts++;
  const bump = (id) => {
    const q = QUESTS.find((x) => x.id === id), before = S.day.quests[id] || 0;
    S.day.quests[id] = before + 1;
    if (before + 1 === q.target) { got += addXP(q.bonus); msgs.push('Quest done: ' + q.name.slice(2).trim()); }
  };
  if (a.parts.some((p) => p.bin === 'recyclable')) bump('recycle3');
  if (a.parts.length > 1) bump('split1');
  if (a.parts.some((p) => p.bin === 'organic')) bump('organic1');
  save();
  $('btn-threw').disabled = true;
  $('btn-threw').textContent = got > 0 ? `Nice! +${got} XP 🌱` : 'Saved. Daily XP limit reached';
  toast(msgs[0] || (got > 0 ? `+${got} XP for ${S.profile.dorm}` : 'Daily limit reached, see you tomorrow'));
}
function report() {
  if (!current) return;
  // Only the AI text answer is kept for the team to review. No photo.
  S.reports.push({ at: new Date().toISOString(), item: current.item, bins: current.parts.map((p) => p.bin), demo: !!current._demo });
  save(); $('btn-report').disabled = true; $('btn-report').textContent = 'Thanks, report saved (no photo kept)';
}

/* ---------- leaderboard ---------- */
function renderBoard() {
  const rows = dormTable();
  const top = rows.slice(0, 3), order = [top[1], top[0], top[2]], h = [70, 96, 54], medal = ['🥈', '🥇', '🥉'], bg = ['#c8e6c9', '#81c784', '#e8f5e9'];
  $('podium').innerHTML = order.map((r, i) => r ? `<div><div style="font-size:22px">${medal[i]}</div><div style="height:${h[i]}px;background:${bg[i]}"><b>${r[0]}</b><br>${r[1].toLocaleString()}</div></div>` : '').join('');
  $('lb').innerHTML = rows.map((r, i) => `<li class="${r[0] === S.profile.dorm ? 'me' : ''}"><span class="n">${i + 1}</span><span style="flex:1">${r[0]}${r[0] === S.profile.dorm ? ' <span class="small">(your dorm)</span>' : ''}</span><b>${r[1].toLocaleString()} XP</b></li>`).join('');
  $('mypart').innerHTML = `<b style="color:#1f2a22">Your part this week</b><div class="row" style="margin-top:4px"><span>Items sorted: <b>${S.week.sorts}</b></span><span>XP given: <b>${S.week.xp}</b></span></div><div style="margin-top:4px">Shown as nickname only: ${esc(S.profile.nick)}</div>`;
}

/* ---------- settings ---------- */
function renderSettings() {
  $('key').value = S.settings.key; $('model').value = S.settings.model; $('lang').value = S.settings.lang;
  $('demo').checked = S.settings.demo; $('demosample').value = S.settings.demoSample;
  $('datainfo').innerHTML = `Saved on this phone: nickname <b>${esc(S.profile.nick)}</b>, dorm <b>${esc(S.profile.dorm)}</b>, ${S.totalXP} XP, ${S.sorts} sorts, ${S.reports.length} wrong-answer reports, your settings. <b>No photos.</b>`;
}
function initSettings() {
  $('btn-save').onclick = () => {
    S.settings.key = $('key').value.trim(); S.settings.model = $('model').value.trim() || DEFAULT_MODEL; S.settings.lang = $('lang').value;
    save(); toast('Settings saved');
  };
  $('demo').onchange = () => { S.settings.demo = $('demo').checked; save(); applyDemo(); toast(S.settings.demo ? 'Demo mode ON' : 'Demo mode OFF'); };
  $('demosample').onchange = () => { S.settings.demoSample = $('demosample').value; save(); };
  $('btn-wipe').onclick = () => {
    if (!confirm('Delete your nickname, points, reports and API key from this phone?')) return;
    localStorage.removeItem(LS); S = load(); clearPhoto(); current = null; applyDemo(); go('consent');
  };
}
function applyDemo() { document.body.classList.toggle('demo', !!S.settings.demo); }

/* ---------- start ---------- */
document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
$('file').addEventListener('change', onFile);
$('btn-analyze').addEventListener('click', analyze);
initConsent(); initSettings(); applyDemo();
const start = location.hash.slice(1);
go(S.profile ? (['home', 'scan', 'board', 'settings'].includes(start) ? start : 'home') : 'consent');
