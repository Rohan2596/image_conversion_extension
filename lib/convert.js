// Shared by the popup and the background service worker.
export const FORMATS = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  jpg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' }
};
export const KEEP = 'same';

export const DEFAULTS = {
  mode: 'convert',        // 'convert' | 'shrink'
  format: 'webp',         // output format in Convert mode
  shrinkFormat: 'jpg',    // output format in Shrink mode (jpg | same | webp)
  quality: 85,
  background: '#ffffff',  // fill for transparent areas when saving as JPG
  maxWidth: 0,            // 0 = original width
  targetKB: 0,            // 0 = no size limit (1 KB = 1,000 bytes)
  keepDimensions: false
};

export const SIZE_CHIPS = [
  { kb: 20, label: '20 KB' }, { kb: 50, label: '50 KB' }, { kb: 100, label: '100 KB' },
  { kb: 200, label: '200 KB' }, { kb: 500, label: '500 KB' }, { kb: 1000, label: '1 MB' }
];

// Turns saved settings into the options convertBlob needs.
export function effectiveOptions(s, formatOverride) {
  const shrink = s.mode === 'shrink';
  return {
    format: formatOverride ?? (shrink ? s.shrinkFormat : s.format),
    quality: s.quality,
    background: s.background,
    maxWidth: s.maxWidth,
    targetKB: shrink ? s.targetKB : 0,
    keepDimensions: shrink && !!s.keepDimensions
  };
}

const TYPE_LABELS = {
  'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP',
  'image/gif': 'GIF', 'image/avif': 'AVIF', 'image/bmp': 'BMP'
};
export const typeLabel = (mime) => TYPE_LABELS[mime] || 'Image';

export function resolveFormat(mime, choice) {
  if (choice !== KEEP) return choice;
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  return 'webp';
}

// True when the file is already in one of our three output formats.
export function isSameFormat(mime, format) {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mime) && resolveFormat(mime, KEEP) === format;
}

// Heuristic check for animated GIF / WebP / APNG. Only the first frame survives conversion.
export async function isAnimated(file) {
  try {
    if (file.type === 'image/gif') {
      const b = new Uint8Array(await file.arrayBuffer());
      let n = 0;
      for (let i = 0; i < b.length - 3; i++) {
        if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04 && ++n > 1) return true;
      }
      return false;
    }
    if (file.type === 'image/webp') {
      const b = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      const is = (o, t) => [...t].every((ch, i) => b[o + i] === ch.charCodeAt(0));
      return is(0, 'RIFF') && is(8, 'WEBP') && is(12, 'VP8X') && (b[20] & 0x02) !== 0;
    }
    if (file.type === 'image/png') {
      const b = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
      for (let i = 0; i < b.length - 3; i++) {
        if (b[i] === 0x61 && b[i + 1] === 0x63 && b[i + 2] === 0x54 && b[i + 3] === 0x4c) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function hasAlpha(bmp) {
  const c = new OffscreenCanvas(32, 32);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

async function encode(bmp, scale, format, q, background) {
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (format === 'jpg') {
    // JPG has no transparency, so paint a solid background first.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bmp, 0, 0, width, height);
  const opts = { type: FORMATS[format].mime };
  if (format !== 'png') opts.quality = q;
  return { blob: await canvas.convertToBlob(opts), width, height };
}

// Finds the highest quality (between qFloor and qMax) that fits under `target` bytes.
async function fitQuality(bmp, scale, format, qMax, target, background, qFloor) {
  const top = await encode(bmp, scale, format, qMax, background);
  if (top.blob.size <= target) return { enc: top, q: qMax, met: true };
  let lo = Math.min(qFloor, qMax), hi = qMax;
  const floor = await encode(bmp, scale, format, lo, background);
  if (floor.blob.size > target) return { enc: floor, q: lo, met: false };
  let best = { enc: floor, q: lo, met: true };
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const enc = await encode(bmp, scale, format, mid, background);
    if (enc.blob.size <= target) { best = { enc, q: mid, met: true }; lo = mid; } else { hi = mid; }
  }
  return best;
}

/**
 * Converts and optionally shrinks an image.
 * Returns { blob, width, height, srcWidth, srcHeight, format, quality, resized, targetMet, flattened }.
 */
export async function convertBlob(blob, o) {
  const format = resolveFormat(blob.type, o.format);
  const bmp = await createImageBitmap(blob);
  try {
    const srcWidth = bmp.width, srcHeight = bmp.height;
    const keep = !!o.keepDimensions;
    let scale = !keep && o.maxWidth > 0 && srcWidth > o.maxWidth ? o.maxWidth / srcWidth : 1;
    const qMax = Math.min(1, Math.max(0.1, o.quality / 100));
    const target = o.targetKB > 0 ? Math.round(o.targetKB * 1000) : 0;
    const qFloor = keep ? 0.1 : 0.4; // with Keep dimensions we may go lower to get as close as possible
    let enc, q = format === 'png' ? null : qMax, targetMet = true;

    if (!target) {
      enc = await encode(bmp, scale, format, qMax, o.background);
    } else {
      targetMet = false;
      // Lower the quality first, then shrink the dimensions by 15% per step (unless told to keep them).
      for (let i = 0; i < 14; i++) {
        if (format === 'png') {
          enc = await encode(bmp, scale, format, 1, o.background);
          targetMet = enc.blob.size <= target;
        } else {
          const fit = await fitQuality(bmp, scale, format, qMax, target, o.background, qFloor);
          enc = fit.enc; q = fit.q; targetMet = fit.met;
        }
        if (targetMet || keep || Math.round(srcWidth * scale * 0.85) < 32) break;
        scale *= 0.85;
      }
    }
    return {
      blob: enc.blob, width: enc.width, height: enc.height, srcWidth, srcHeight, format,
      quality: q === null ? null : Math.round(q * 100),
      resized: enc.width !== srcWidth, targetMet,
      flattened: format === 'jpg' && blob.type !== 'image/jpeg' && hasAlpha(bmp)
    };
  } finally {
    bmp.close();
  }
}

export function newName(name, format) {
  const base = (name || 'image').replace(/\.[^./\\?#]+$/, '') || 'image';
  return `${base}.${FORMATS[format].ext}`;
}

export function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(2)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(2)} GB`;
}

export function changePct(before, after) {
  if (!before) return '';
  const d = Math.round((1 - after / before) * 100);
  return d >= 0 ? `${d}% smaller` : `${Math.abs(d)}% larger`;
}
