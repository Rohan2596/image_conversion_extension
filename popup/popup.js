import {
  DEFAULTS, SIZE_CHIPS, FORMATS, convertBlob, effectiveOptions, isAnimated, isSameFormat,
  newName, formatBytes, changePct, typeLabel
} from '../lib/convert.js';
import { addStats, getStats } from '../lib/stats.js';

const $ = (s) => document.querySelector(s);
const state = { ...DEFAULTS };
let items = []; // { file, url, animated, working, res, outBlob, outName, outUrl, kept, notes, error, ver }
let runId = 0, timer;

const tabs = [...document.querySelectorAll('.tabs button')];
const seg = [...document.querySelectorAll('.seg button')];
const panels = { convert: $('#panel-convert'), shrink: $('#panel-shrink') };
const qualityEl = $('#quality'), qualityOut = $('#qualityOut'), bgEl = $('#background');
const widthEl = $('#maxWidth'), targetEl = $('#targetKB'), shrinkFormatEl = $('#shrinkFormat'), keepDimsEl = $('#keepDims');
const chipsEl = $('#chips');
const resultsEl = $('#results'), actionsEl = $('#actions'), dropEl = $('#drop'), fileEl = $('#file');
const summaryEl = $('#summary'), lifetimeEl = $('#lifetime');

if (location.search.includes('tab=1')) {
  document.documentElement.classList.add('tab');
  $('#openTab').hidden = true;
}
$('#openTab').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?tab=1') });
});

const chipButtons = SIZE_CHIPS.map((c) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = c.label;
  b.addEventListener('click', () => {
    state.targetKB = state.targetKB === c.kb ? 0 : c.kb;
    syncControls(); save(150);
  });
  chipsEl.append(b);
  return b;
});

function syncControls() {
  const eff = effectiveOptions(state);
  tabs.forEach((t) => {
    const on = t.dataset.mode === state.mode;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  panels.convert.hidden = state.mode !== 'convert';
  panels.shrink.hidden = state.mode !== 'shrink';
  seg.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.format === state.format)));
  SIZE_CHIPS.forEach((c, i) => chipButtons[i].setAttribute('aria-pressed', String(state.targetKB === c.kb)));
  if (document.activeElement !== targetEl) targetEl.value = state.targetKB || '';
  shrinkFormatEl.value = state.shrinkFormat;
  keepDimsEl.checked = state.keepDimensions;
  qualityEl.value = state.quality;
  qualityOut.textContent = `${state.quality}%`;
  $('#qualityLabel').textContent = state.mode === 'shrink' ? 'Highest quality' : 'Quality';
  $('#qualityRow').hidden = eff.format === 'png';
  $('#bgRow').hidden = eff.format !== 'jpg';
  if (document.activeElement !== widthEl) widthEl.value = state.maxWidth || '';
  widthEl.disabled = eff.keepDimensions;
  bgEl.value = state.background;
}

function save(delay = 200) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = state[k];
  chrome.storage.local.set(out);
  clearTimeout(timer);
  timer = setTimeout(convertAll, delay);
}

tabs.forEach((t) => t.addEventListener('click', () => { state.mode = t.dataset.mode; syncControls(); save(100); }));
seg.forEach((b) => b.addEventListener('click', () => { state.format = b.dataset.format; syncControls(); save(100); }));
targetEl.addEventListener('input', () => {
  state.targetKB = Math.max(0, parseInt(targetEl.value, 10) || 0);
  syncControls(); save(500);
});
shrinkFormatEl.addEventListener('change', () => { state.shrinkFormat = shrinkFormatEl.value; syncControls(); save(100); });
keepDimsEl.addEventListener('change', () => { state.keepDimensions = keepDimsEl.checked; syncControls(); save(100); });
qualityEl.addEventListener('input', () => { state.quality = Number(qualityEl.value); qualityOut.textContent = `${state.quality}%`; });
qualityEl.addEventListener('change', () => save(100)); // re-encode only when the slider is released
widthEl.addEventListener('input', () => { state.maxWidth = Math.max(0, parseInt(widthEl.value, 10) || 0); save(500); });
bgEl.addEventListener('change', () => { state.background = bgEl.value; save(100); });

function freeUrl(it) {
  if (it.outUrl) URL.revokeObjectURL(it.outUrl);
  it.outUrl = null;
}

async function convertItem(it) {
  const ver = (it.ver = (it.ver || 0) + 1);
  const eff = effectiveOptions(state);
  let res;
  try {
    res = await convertBlob(it.file, eff);
  } catch {
    if (it.ver === ver) { freeUrl(it); it.res = it.outBlob = null; it.error = 'Couldn’t read this file as an image.'; }
    return;
  }
  if (it.ver !== ver) return; // settings changed while this was running

  freeUrl(it);
  it.error = null; it.res = res; it.kept = false; it.notes = [];
  it.outBlob = res.blob; it.outName = newName(it.file.name, res.format);

  // Shrink mode: never make a file bigger, and leave files that already fit alone.
  if (state.mode === 'shrink' && isSameFormat(it.file.type, res.format)) {
    const target = eff.targetKB * 1000;
    if (target && it.file.size <= target) {
      it.kept = true;
      it.notes.push({ kind: 'info', text: 'Already under the limit. Original kept.' });
    } else if (res.blob.size >= it.file.size) {
      it.kept = true;
      it.notes.push({ kind: 'info', text: 'Re-encoding wouldn’t make it smaller. Original kept.' });
    }
    if (it.kept) { it.outBlob = it.file; it.outName = it.file.name; }
  }

  if (it.animated) it.notes.push({ kind: 'warn', text: 'This looks animated. Only the first frame is converted.' });
  if (res.flattened) it.notes.push({ kind: 'warn', text: `Transparent areas were filled with ${state.background}.` });
  if (!res.targetMet && !it.kept) {
    const t = formatBytes(eff.targetKB * 1000);
    it.notes.push({
      kind: 'warn',
      text: res.format === 'png' && eff.keepDimensions
        ? `PNG can’t reach ${t} without resizing. Choose JPG output or turn off Keep dimensions.`
        : `Couldn’t reach ${t}${eff.keepDimensions ? ' at these dimensions' : ''}. This is the closest result.`
    });
  }
  if (!it.kept && it.outBlob.size > it.file.size && state.mode === 'shrink') {
    it.notes.push({ kind: 'warn', text: 'Larger than the original. Try JPG or WebP output.' });
  }
  it.outUrl = URL.createObjectURL(it.outBlob);
}

async function convertAll() {
  const id = ++runId;
  items.forEach((i) => { i.working = true; });
  render();
  for (const it of items) {
    if (id !== runId) return;
    await convertItem(it);
    if (id !== runId) return;
    it.working = false;
    render();
  }
}

function line(cls, text) {
  const d = document.createElement('div');
  d.className = cls; d.textContent = text;
  return d;
}

function render() {
  resultsEl.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = it.url; img.alt = '';
    const info = document.createElement('div');
    li.append(img, info);
    resultsEl.append(li);

    if (it.working) { info.append(line('name', it.file.name), line('meta', 'Working…')); continue; }
    if (it.error) { info.append(line('name', it.file.name), line('size err', it.error)); continue; }

    const r = it.res;
    const larger = it.outBlob.size > it.file.size;
    const fmtTo = it.kept ? typeLabel(it.file.type) : FORMATS[r.format].label;
    info.append(
      line('name', it.outName),
      line(`size${larger ? ' warn' : ''}`, `${formatBytes(it.file.size)} → ${formatBytes(it.outBlob.size)} (${changePct(it.file.size, it.outBlob.size)})`),
      line('meta', [
        it.kept ? `${r.srcWidth}×${r.srcHeight}` : `${r.srcWidth}×${r.srcHeight}${r.resized ? ` → ${r.width}×${r.height}` : ''}`,
        `${typeLabel(it.file.type)} → ${fmtTo}`,
        it.kept ? 'unchanged' : (r.quality === null ? 'lossless' : `quality ${r.quality}%`)
      ].join(' · '))
    );
    for (const n of it.notes) info.append(line(n.kind === 'warn' ? 'warn' : 'meta', n.text));

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (it.outBlob.type === 'image/png') {
      const copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'ghost small'; copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyItem(it, copy));
      actions.append(copy);
    }
    const a = document.createElement('a');
    a.className = 'dl'; a.textContent = 'Download';
    a.href = it.outUrl; a.download = it.outName;
    a.addEventListener('click', () => countDownload(it));
    actions.append(a);
    li.append(actions);
  }

  const ok = items.filter((i) => !i.working && !i.error && i.res);
  const before = ok.reduce((n, i) => n + i.file.size, 0);
  const after = ok.reduce((n, i) => n + i.outBlob.size, 0);
  summaryEl.hidden = ok.length === 0;
  if (ok.length) {
    summaryEl.textContent = `${ok.length} image${ok.length > 1 ? 's' : ''} · ${formatBytes(before)} → ${formatBytes(after)} · ${changePct(before, after)}`;
  }
  actionsEl.hidden = items.length === 0;
  $('#downloadAll').hidden = ok.length < 2;
}

async function copyItem(it, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': it.outBlob })]);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = label; }, 1500);
}

async function countDownload(it) {
  await addStats(it.file.size, it.outBlob.size);
  showLifetime();
}

async function showLifetime() {
  const s = await getStats();
  lifetimeEl.hidden = s.count === 0;
  if (s.count) lifetimeEl.textContent = `All time: ${s.count} image${s.count > 1 ? 's' : ''} saved, ${formatBytes(s.saved)} less to store or send.`;
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  for (const file of files) {
    items.push({ file, url: URL.createObjectURL(file), animated: await isAnimated(file), working: true });
  }
  await convertAll();
}

fileEl.addEventListener('change', () => { addFiles(fileEl.files); fileEl.value = ''; });
dropEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileEl.click(); } });
['dragenter', 'dragover'].forEach((t) => dropEl.addEventListener(t, (e) => { e.preventDefault(); dropEl.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => dropEl.addEventListener(t, (e) => { e.preventDefault(); dropEl.classList.remove('over'); }));
dropEl.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
document.addEventListener('paste', (e) => addFiles(e.clipboardData.files));

$('#downloadAll').addEventListener('click', () => {
  items.filter((i) => i.outUrl && !i.working).forEach((it, n) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = it.outUrl; a.download = it.outName; a.click();
      countDownload(it);
    }, n * 250);
  });
});
$('#clear').addEventListener('click', () => {
  runId++;
  items.forEach((i) => { URL.revokeObjectURL(i.url); freeUrl(i); });
  items = []; render();
});

chrome.storage.local.get(DEFAULTS).then((s) => { Object.assign(state, s); syncControls(); });
showLifetime();
