// GET /api/media?key=<ACCESS_KEY>&name=<file name>&u=<url>&u=<url>...
// Tries each Douyin media URL in order and streams back the first one that responds.
// Used for images and live clips returned by /api/download?format=list.

export const config = { runtime: 'edge', regions: ['hkg1'] };

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

// Only Douyin media hosts
const MEDIA_HOSTS = ['douyinpic.com', 'douyinvod.com', 'douyincdn.com', 'snssdk.com', 'amemv.com', 'zjcdn.com'];
const isMediaHost = (u) => {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' && MEDIA_HOSTS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
};

const MAX_URLS = 8;
const CONNECT_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 20000;

const text = (msg, status) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });

// Constant-time string compare
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(request) {
  const started = Date.now();
  const params = new URL(request.url).searchParams;
  if (!safeEqual(params.get('key') || '', process.env.ACCESS_KEY || '')) return text('Unauthorized', 401);
  const urls = params.getAll('u').filter(isMediaHost).slice(0, MAX_URLS);
  if (!urls.length) return text('No valid media URL', 400);
  const name = (params.get('name') || 'douyin').replace(/[^\w-]/g, '').slice(0, 80) || 'douyin';

  const tried = [];
  for (const url of urls) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left <= 0) break;
    const host = new URL(url).host;
    // Abort only if the headers do not arrive in time; the body may stream longer
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(CONNECT_TIMEOUT_MS, left));
    try {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!upstream.ok || !upstream.body) {
        upstream.body?.cancel();
        tried.push(`${host}:${upstream.status}`);
        continue;
      }
      const type = upstream.headers.get('content-type') || 'application/octet-stream';
      const headers = new Headers({
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${name}.${extFor(type)}"`,
        'Cache-Control': 'no-store',
      });
      const len = upstream.headers.get('content-length');
      if (len) headers.set('Content-Length', len);
      console.log(JSON.stringify({ event: 'test_media', name, host, tries: tried.length + 1, ms: Date.now() - started }));
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      clearTimeout(timer);
      tried.push(`${host}:timeout_or_error`);
    }
  }
  console.log(JSON.stringify({ event: 'test_media_failed', name, tried }));
  return text(`All media URLs failed: ${tried.join(', ')}`, 502);
}

function extFor(type) {
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('heic')) return 'heic';
  if (type.includes('video')) return 'mp4';
  return 'bin';
}
