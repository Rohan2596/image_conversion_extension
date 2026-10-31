// Lifetime totals, stored only in chrome.storage.local on this device.
export async function addStats(bytesIn, bytesOut) {
  const { stats } = await chrome.storage.local.get('stats');
  const s = stats || { count: 0, saved: 0 };
  s.count += 1;
  s.saved += Math.max(0, bytesIn - bytesOut);
  await chrome.storage.local.set({ stats: s });
}

export async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats || { count: 0, saved: 0 };
}
