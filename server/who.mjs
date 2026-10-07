// Who used a key: the date, an approximate place (city / region / country from the internet address - the address
// itself is not kept) and the operating system and browser. The page says so next to the key box.

/** The visitor's address behind Render's proxy. */
export function clientIp(req) {
  const h = req.headers;
  const fwd = String(h['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return String(h['true-client-ip'] || h['cf-connecting-ip'] || fwd || req.socket?.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .trim();
}

const isPrivate = (ip) => !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i.test(ip);

async function getJson(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'simurgh-download/1' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** { city, region, country } for an address (two free services, 3 s each); unknown parts are ''. */
export async function placeOf(ip, { lookup = getJson, countryHint = '' } = {}) {
  if (isPrivate(ip)) return { city: '', region: '', country: 'local network' };
  try {
    const a = await lookup(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, 3000);
    if (a && !a.error && (a.country_name || a.city)) return { city: a.city || '', region: a.region || '', country: a.country_name || '' };
  } catch {}
  try {
    const b = await lookup(`https://ipwho.is/${encodeURIComponent(ip)}`, 3000);
    if (b && b.success !== false && (b.country || b.city)) return { city: b.city || '', region: b.region || '', country: b.country || '' };
  } catch {}
  return { city: '', region: '', country: countryHint || '' };
}

/**
 * The operating system and browser: the page sends what the browser tells about itself (userAgentData - it knows
 * Windows 11 from 10); the User-Agent line is the fallback.
 */
export function deviceOf(userAgent = '', hints = {}) {
  const ua = String(userAgent);
  let os = '';
  const platform = String(hints.platform || '');
  const pv = String(hints.platformVersion || '');
  if (/^windows$/i.test(platform) && pv) {
    const major = Number(pv.split('.')[0]);
    os = major >= 13 ? 'Windows 11' : major > 0 ? 'Windows 10' : 'Windows 7/8';
  } else if (/^macos$/i.test(platform) && pv) os = `macOS ${pv.split('.').slice(0, 2).join('.')}`;
  else if (/^android$/i.test(platform) && pv) os = `Android ${pv.split('.')[0]}`;
  if (!os) {
    if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
    else if (/Windows NT 6\.[12]/.test(ua)) os = 'Windows 7/8';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Android ([\d.]+)/.test(ua)) os = `Android ${/Android ([\d]+)/.exec(ua)[1]}`;
    else if (/(iPhone|iPad); CPU (iPhone )?OS ([\d_]+)/.test(ua)) os = `iOS ${/OS ([\d]+)/.exec(ua)[1]}`;
    else if (/Mac OS X ([\d_]+)/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    else os = 'unknown';
  }
  if (/\b(Win64|x64|WOW64|x86_64)\b/.test(ua) && os.startsWith('Windows')) os += ' 64-bit';
  else if (hints.bitness === '64' && os.startsWith('Windows')) os += ' 64-bit';
  let browser = 'unknown';
  if (/Edg\/(\d+)/.test(ua)) browser = `Edge ${/Edg\/(\d+)/.exec(ua)[1]}`;
  else if (/OPR\/(\d+)/.test(ua)) browser = `Opera ${/OPR\/(\d+)/.exec(ua)[1]}`;
  else if (/Firefox\/(\d+)/.test(ua)) browser = `Firefox ${/Firefox\/(\d+)/.exec(ua)[1]}`;
  else if (/Chrome\/(\d+)/.test(ua)) browser = `Chrome ${/Chrome\/(\d+)/.exec(ua)[1]}`;
  else if (/Version\/(\d+).*Safari/.test(ua)) browser = `Safari ${/Version\/(\d+)/.exec(ua)[1]}`;
  return { os, browser };
}
