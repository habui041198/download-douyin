// GET /api/download?key=<ACCESS_KEY>&url=<douyin share link or share text>[&q=540p|720p|1080p][&proxy=1]
// Default: 302 redirect to the Douyin play URL (no Vercel bandwidth).
// proxy=1: stream the video through Vercel as an attachment (fallback).

export const config = { runtime: 'edge', regions: ['hkg1'] };

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Only fetch Douyin hosts (prevents using this endpoint as an open proxy)
const ALLOWED_HOSTS = ['douyin.com', 'iesdouyin.com'];
const isAllowed = (u) => {
  try {
    const h = new URL(u).hostname;
    return ALLOWED_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
};

const VIDEO_ID_RE = /^v\d[a-z0-9]{20,}$/;
// Fallback order after 'default', highest first
const QUALITIES = ['1080p', '720p', '540p'];

// Endpoints come from env only
const PLAY_URL = process.env.DOUYIN_PLAY_URL;
const DETAIL_API = process.env.DOUYIN_DETAIL_API;
const TTWID_API = process.env.TTWID_API;
// Optional: Google Sheets webhook for persistent logs
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET;
const REQUEST_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 12000;

const text = (msg, status) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });

// Constant-time string compare
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Log to Vercel console and, if configured, to the Sheets webhook without delaying the response
async function logEvent(context, data) {
  console.log(JSON.stringify(data));
  if (!LOG_WEBHOOK_URL) return;
  const p = fetch(LOG_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: LOG_WEBHOOK_SECRET, ...data }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  if (context?.waitUntil) context.waitUntil(p);
  else await p;
}

export default async function handler(request, context) {
  const started = Date.now();
  const params = new URL(request.url).searchParams;
  const ip = request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || null;
  if (!safeEqual(params.get('key') || '', process.env.ACCESS_KEY || '')) {
    await logEvent(context, { event: 'unauthorized', ip });
    return text('Unauthorized', 401);
  }
  if (!PLAY_URL || !DETAIL_API || !TTWID_API) return text('Server misconfigured', 500);

  const link = (params.get('url') || '').match(/https?:\/\/[^\s]+/)?.[0];
  if (!link || !isAllowed(link)) return text('Invalid link', 400);

  // Per-request timeout, capped by what is left of the total budget
  const timeout = () => {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left <= 0) throw new Error('Timed out');
    return AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left));
  };

  // format=list: JSON { type, count, items } for both video and image posts
  const asList = params.get('format') === 'list';
  let type = null;
  let count = null;
  let source = null;
  let ratio = null;
  let error = null;
  let awemeId = null;
  let videoId = null;
  try {
    // Resolve the share link and fetch ttwid in parallel
    const [resolved, ttwid] = await Promise.all([resolveAwemeId(link, timeout), getTtwid(timeout)]);
    if (!resolved) {
      error = 'aweme_id not found';
      return text(error, 404);
    }
    awemeId = resolved.awemeId;

    if (isAllowed(resolved.url)) {
      videoId = await fromSharePage(resolved.url, ttwid, timeout);
      if (videoId) source = 'share_page_full';
    }

    // Image posts (/share/slides/) are not server-rendered; /share/video/<id>/ with the same query is
    let images = null;
    if (!videoId) {
      const u = new URL(resolved.url);
      const videoPage = `${u.origin}/share/video/${awemeId}/${u.search}`;
      if (videoPage !== resolved.url && isAllowed(videoPage)) {
        const data = await fetchRouterData(videoPage, ttwid, timeout);
        const item = findItem(data, awemeId);
        if (item?.images?.length) images = item.images.filter(Boolean);
        else videoId = findVideoId(item || data);
        if (images || videoId) source = 'share_page_video';
      }
    }
    if (images) {
      type = 'images';
      if (!asList) {
        error = 'image post: use format=list';
        return text(error, 400);
      }
      // One /api/media URL per image, plus one per live clip
      const origin = publicOrigin(request);
      const key = params.get('key');
      const items = [];
      images.forEach((img, i) => {
        const n = String(i + 1).padStart(2, '0');
        const imageUrls = imageCandidates(img.url_list);
        const clipUrls = img.video?.play_addr?.url_list || [];
        if (imageUrls.length) items.push(mediaUrl(origin, key, imageUrls, `douyin_${awemeId}_${n}`));
        if (clipUrls.length) items.push(mediaUrl(origin, key, clipUrls, `douyin_${awemeId}_${n}_live`));
      });
      count = items.length;
      return Response.json({ type, count, items });
    }

    if (!videoId) {
      videoId = await fromDetailApi(resolved.awemeId, ttwid, timeout);
      if (videoId) source = 'detail_api';
    }
    if (!videoId) {
      error = 'video_id not found';
      return text(error, 404);
    }

    // Explicit q: use it as is. Otherwise try 'default' (best), then fall back high to low.
    const q = params.get('q');
    const candidates = QUALITIES.includes(q) ? [q] : ['default', ...QUALITIES];
    let playUrl = null;
    for (const r of candidates) {
      const url = `${PLAY_URL}?video_id=${videoId}&improve_bitrate=1&ratio=${r}`;
      if (candidates.length === 1 || (await isPlayable(url, timeout))) {
        playUrl = url;
        ratio = r;
        break;
      }
    }
    if (!playUrl) {
      error = 'no playable quality';
      return text(error, 404);
    }
    type = 'video';
    count = 1;
    if (asList) return Response.json({ type, count, items: [playUrl] });
    if (params.get('proxy') !== '1') return Response.redirect(playUrl, 302);

    return await streamVideo(playUrl, videoId);
  } catch (e) {
    error = String(e?.message || e);
    return text(error, 500);
  } finally {
    // Never log the key
    await logEvent(context, {
      event: 'download',
      ip,
      link,
      video_page: awemeId ? `https://www.douyin.com/video/${awemeId}` : null,
      type,
      count,
      video_id: videoId,
      resolve_ms: Date.now() - started,
      source,
      ratio,
      error,
    });
  }
}

// Public origin for item URLs (PUBLIC_ORIGIN overrides, e.g. behind a tunnel that rewrites Host)
function publicOrigin(request) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const u = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || u.protocol.replace(':', '');
  return `${proto}://${u.host}`;
}

function mediaUrl(origin, key, urls, name) {
  const p = new URLSearchParams({ key, name });
  for (const u of urls.slice(0, 8)) p.append('u', u);
  return `${origin}/api/media?${p}`;
}

// JPEG first, then the same JPEG path on the other CDN hosts, then the remaining (WebP) URLs
function imageCandidates(urls) {
  if (!Array.isArray(urls) || !urls.length) return [];
  const jpegs = urls.filter((u) => /\.jpe?g(\?|$)/i.test(u));
  const hosts = [...new Set(urls.map((u) => new URL(u).host))];
  const swapped = jpegs.flatMap((u) =>
    hosts.map((h) => {
      const x = new URL(u);
      x.host = h;
      return x.href;
    })
  );
  return [...new Set([...jpegs, ...swapped, ...urls])];
}

// Parsed window._ROUTER_DATA of a share page, or null
async function fetchRouterData(url, ttwid, timeout) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA_MOBILE,
      Referer: 'https://www.douyin.com/',
      ...(ttwid ? { Cookie: `ttwid=${ttwid}` } : {}),
    },
    signal: timeout(),
  });
  const json = (await r.text()).match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)?.[1];
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

// Find the post object (has aweme_id and either images or video)
function findItem(node, id) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (String(cur.aweme_id) === id && (cur.images || cur.video)) return cur;
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

// Check a play URL without downloading the video: expect a redirect to the CDN
async function isPlayable(url, timeout) {
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' },
      signal: timeout(),
    });
    r.body?.cancel();
    return (r.status >= 300 && r.status < 400 && !!r.headers.get('location')) || r.ok;
  } catch {
    return false;
  }
}

// Follow redirects manually until a URL containing the aweme_id appears
async function resolveAwemeId(link, timeout) {
  let url = link;
  for (let i = 0; i < 5; i++) {
    const id = url.match(/\/(?:video|note|slides)\/(\d+)/)?.[1] || url.match(/modal_id=(\d+)/)?.[1];
    if (id) return { awemeId: id, url };
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA_MOBILE }, signal: timeout() });
    const next = r.headers.get('location');
    if (!next) return null;
    url = new URL(next, url).href;
    if (!isAllowed(url)) return null;
  }
  return null;
}

async function fromSharePage(url, ttwid, timeout) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA_MOBILE,
      Referer: 'https://www.douyin.com/',
      ...(ttwid ? { Cookie: `ttwid=${ttwid}` } : {}),
    },
    signal: timeout(),
  });
  const html = await r.text();
  const json = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)?.[1];
  if (json) {
    try {
      const found = findVideoId(JSON.parse(json));
      if (found) return found;
    } catch {}
  }
  return html.match(/"uri"\s*:\s*"(v\d[a-z0-9]{20,})"/)?.[1] || null;
}

async function fromDetailApi(awemeId, ttwid, timeout) {
  const api = `${DETAIL_API}?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${awemeId}`;
  const r = await fetch(api, {
    headers: {
      'User-Agent': UA_PC,
      Referer: 'https://www.douyin.com/',
      ...(ttwid ? { Cookie: `ttwid=${ttwid}` } : {}),
    },
    signal: timeout(),
  });
  const body = await r.text();
  try {
    return body ? findVideoId(JSON.parse(body)) : null;
  } catch {
    return null;
  }
}

async function getTtwid(timeout) {
  try {
    const r = await fetch(TTWID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA_PC },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrl: 'https://www.ixigua.com',
        union: true,
      }),
      signal: timeout(),
    });
    const cookies = r.headers.getSetCookie?.() || [r.headers.get('set-cookie') || ''];
    return cookies.join(';').match(/ttwid=([^;]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

// Deep-search a parsed JSON tree for video.play_addr.uri
function findVideoId(node) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const uri = cur.play_addr?.uri;
    if (typeof uri === 'string' && VIDEO_ID_RE.test(uri)) return uri;
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

async function streamVideo(playUrl, videoId) {
  const upstream = await fetch(playUrl, {
    headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' },
    redirect: 'follow',
  });
  if (!upstream.ok || !upstream.body) return text(`Upstream error ${upstream.status}`, 502);

  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
    'Content-Disposition': `attachment; filename="douyin_${videoId}.mp4"`,
    'Cache-Control': 'no-store',
  });
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  return new Response(upstream.body, { status: 200, headers });
}
