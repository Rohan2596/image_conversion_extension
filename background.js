import { FORMATS, KEEP, DEFAULTS, convertBlob, effectiveOptions, newName } from './lib/convert.js';
import { addStats } from './lib/stats.js';

const PARENT = 'ic-parent';
const TAB_URL = () => chrome.runtime.getURL('popup/popup.html?tab=1');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: PARENT, title: 'Save image as…', contexts: ['image'] });
    for (const [key, f] of Object.entries(FORMATS)) {
      chrome.contextMenus.create({ id: `ic-${key}`, parentId: PARENT, title: f.label, contexts: ['image'] });
    }
    chrome.contextMenus.create({ id: 'ic-sep', parentId: PARENT, type: 'separator', contexts: ['image'] });
    chrome.contextMenus.create({
      id: `ic-${KEEP}`, parentId: PARENT, title: 'Same format, smaller', contexts: ['image']
    });
  });
});

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function getBlob(url) {
  try {
    return await fetchImage(url);
  } catch (e) {
    // Cross-origin image blocked: ask once for access (runs inside the click gesture).
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch { /* no gesture */ }
    if (!granted) throw Object.assign(e, { declined: true });
    return fetchImage(url);
  }
}

function toDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${blob.type};base64,${btoa(bin)}`;
  });
}

function fileNameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return decodeURIComponent(last) || 'image';
  } catch { return 'image'; }
}

function describeError(err) {
  const msg = String((err && err.message) || err);
  if (err && err.declined) {
    return 'This site blocks direct access to its image, and access wasn’t allowed. Drop the image into the converter instead.';
  }
  if (/^HTTP \d+/.test(msg)) {
    return `The site returned an error (${msg.slice(5)}). The image may have expired. Try dropping the file into the converter.`;
  }
  if (err && (err.name === 'InvalidStateError' || err.name === 'EncodingError' || /decode|source image|bitmap/i.test(msg))) {
    return 'The browser can’t read this image type (for example SVG, or a damaged file).';
  }
  return 'Something went wrong while converting this image.';
}

function notifyError(err) {
  chrome.notifications.create('ic-error', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Couldn’t convert that image',
    message: describeError(err),
    buttons: [{ title: 'Open converter' }]
  });
}

function openConverter(id) {
  if (id !== 'ic-error') return;
  chrome.tabs.create({ url: TAB_URL() });
  chrome.notifications.clear(id);
}
chrome.notifications.onButtonClicked.addListener((id) => openConverter(id));
chrome.notifications.onClicked.addListener((id) => openConverter(id));

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.menuItemId.startsWith('ic-') || info.menuItemId === PARENT || info.menuItemId === 'ic-sep') return;
  const format = info.menuItemId.slice(3);
  try {
    const stored = await chrome.storage.local.get(DEFAULTS);
    const src = await getBlob(info.srcUrl);
    const res = await convertBlob(src, effectiveOptions(stored, format));
    await chrome.downloads.download({
      url: await toDataUrl(res.blob),
      filename: newName(fileNameFromUrl(info.srcUrl), res.format)
    });
    await addStats(src.size, res.blob.size);
  } catch (err) {
    console.error('Conversion failed:', err);
    notifyError(err);
  }
});
