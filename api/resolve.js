// GET /api/resolve?url=<douyin share link or share text>
// Test endpoint: tries several strategies and reports what worked.

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

export default async function handler(req, res) {
  const debug = [];
  const input = String(req.query.url || '');
  const link = input.match(/https?:\/\/[^\s]+/)?.[0];
  if (!link || !isAllowed(link)) {
    return res.status(400).json({ ok: false, error: 'Invalid or non-Douyin link' });
  }

  try {
    const resolved = await resolveAwemeId(link, debug);
    if (!resolved) return res.status(200).json({ ok: false, error: 'aweme_id not found', debug });
    const { awemeId, url: shareUrl } = resolved;

    const ttwid = await getTtwid(debug);
    const result =
      (await trySharePage(`https://www.iesdouyin.com/share/video/${awemeId}/`, null, 'share_page', debug)) ||
      (isAllowed(shareUrl) && (await trySharePage(shareUrl, ttwid, 'share_page_full', debug))) ||
      (await tryDetailApi(awemeId, ttwid, debug));

    if (!result) return res.status(200).json({ ok: false, aweme_id: awemeId, error: 'video_id not found', debug });

    return res.status(200).json({
      ok: true,
      aweme_id: awemeId,
      ...result,
      play_url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${result.video_id}&improve_bitrate=1&ratio=default`,
      debug,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), debug });
  }
}

// Follow redirects manually until a URL containing the aweme_id appears
async function resolveAwemeId(link, debug) {
  let url = link;
  for (let i = 0; i < 5; i++) {
    const id = url.match(/\/(?:video|note)\/(\d+)/)?.[1] || url.match(/modal_id=(\d+)/)?.[1];
    if (id) {
      debug.push({ step: 'resolve', url });
      return { awemeId: id, url };
    }
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA_MOBILE },
      signal: AbortSignal.timeout(8000),
    });
    const next = r.headers.get('location');
    debug.push({ step: 'redirect', url, status: r.status, location: next });
    if (!next) return null;
    url = new URL(next, url).href;
    if (!isAllowed(url)) return null;
  }
  return null;
}

// Strategy 1: SSR share page (window._ROUTER_DATA)
async function trySharePage(url, ttwid, step, debug) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA_MOBILE,
      Referer: 'https://www.douyin.com/',
      ...(ttwid ? { Cookie: `ttwid=${ttwid}` } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  const html = await r.text();
  const entry = { step, status: r.status, length: html.length };
  debug.push(entry);

  const json = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)?.[1];
  entry.hasRouterData = !!json;
  if (json) {
    try {
      const data = JSON.parse(json);
      // List page keys to see whether videoInfoRes is present
      const page = Object.values(data.loaderData || {}).find((v) => v && typeof v === 'object');
      entry.pageKeys = page ? Object.keys(page) : [];
      const found = findVideo(data);
      if (found) return { source: step, ...found };
    } catch (e) {
      entry.parseError = String(e.message);
    }
  }
  const uri = html.match(/"uri"\s*:\s*"(v\d[a-z0-9]{20,})"/)?.[1];
  return uri ? { source: step + '_regex', video_id: uri } : null;
}

// Strategy 2: web detail API with an anonymous ttwid cookie (no a_bogus yet)
async function tryDetailApi(awemeId, ttwid, debug) {
  const api =
    'https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web' +
    `&aweme_id=${awemeId}`;
  const r = await fetch(api, {
    headers: {
      'User-Agent': UA_PC,
      Referer: 'https://www.douyin.com/',
      ...(ttwid ? { Cookie: `ttwid=${ttwid}` } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  const body = await r.text();
  const entry = { step: 'detail_api', status: r.status, length: body.length, hasTtwid: !!ttwid };
  debug.push(entry);
  if (!body) return null;
  try {
    const found = findVideo(JSON.parse(body));
    if (found) return { source: 'detail_api', ...found };
    entry.sample = body.slice(0, 300);
  } catch (e) {
    entry.parseError = String(e.message);
    entry.sample = body.slice(0, 300);
  }
  return null;
}

async function getTtwid(debug) {
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
      signal: AbortSignal.timeout(8000),
    });
    const cookies = r.headers.getSetCookie?.() || [r.headers.get('set-cookie') || ''];
    const ttwid = cookies.join(';').match(/ttwid=([^;]+)/)?.[1] || null;
    debug.push({ step: 'ttwid', status: r.status, ok: !!ttwid });
    return ttwid;
  } catch (e) {
    debug.push({ step: 'ttwid', error: String(e.message) });
    return null;
  }
}

// Deep-search a parsed JSON tree for video.play_addr
function findVideo(node) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const pa = cur.play_addr;
    if (pa && typeof pa.uri === 'string' && VIDEO_ID_RE.test(pa.uri)) {
      return { video_id: pa.uri, url_list: pa.url_list || [] };
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}
