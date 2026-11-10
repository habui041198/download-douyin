// GET /api/download?key=<ACCESS_KEY>&url=<douyin share link or share text>[&proxy=1]
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
const timeout = () => AbortSignal.timeout(8000);
const text = (msg, status) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });

// Constant-time string compare
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(request) {
  const params = new URL(request.url).searchParams;
  if (!safeEqual(params.get('key') || '', process.env.ACCESS_KEY || '')) return text('Unauthorized', 401);

  const link = (params.get('url') || '').match(/https?:\/\/[^\s]+/)?.[0];
  if (!link || !isAllowed(link)) return text('Invalid link', 400);

  try {
    const resolved = await resolveAwemeId(link);
    if (!resolved) return text('aweme_id not found', 404);

    const ttwid = await getTtwid();
    const videoId =
      (await fromSharePage(`https://www.iesdouyin.com/share/video/${resolved.awemeId}/`, null)) ||
      (isAllowed(resolved.url) && (await fromSharePage(resolved.url, ttwid))) ||
      (await fromDetailApi(resolved.awemeId, ttwid));
    if (!videoId) return text('video_id not found', 404);

    const playUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&improve_bitrate=1&ratio=default`;
    if (params.get('proxy') !== '1') return Response.redirect(playUrl, 302);

    return await streamVideo(playUrl, videoId);
  } catch (e) {
    return text(String(e?.message || e), 500);
  }
}

// Follow redirects manually until a URL containing the aweme_id appears
async function resolveAwemeId(link) {
  let url = link;
  for (let i = 0; i < 5; i++) {
    const id = url.match(/\/(?:video|note)\/(\d+)/)?.[1] || url.match(/modal_id=(\d+)/)?.[1];
    if (id) return { awemeId: id, url };
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA_MOBILE }, signal: timeout() });
    const next = r.headers.get('location');
    if (!next) return null;
    url = new URL(next, url).href;
    if (!isAllowed(url)) return null;
  }
  return null;
}

async function fromSharePage(url, ttwid) {
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

async function fromDetailApi(awemeId, ttwid) {
  const api =
    'https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web' +
    `&aweme_id=${awemeId}`;
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

async function getTtwid() {
  try {
    const r = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
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
