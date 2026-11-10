# douyin-dl

Personal endpoint for an iOS Shortcut: paste a Douyin share link, get the video.

## Setup

- Vercel → Project → Settings → Environment Variables: add `ACCESS_KEY` (long random string), then redeploy.
- Functions run in Hong Kong (`hkg1`).

## API

`GET /api/download?key=<ACCESS_KEY>&url=<share link or share text>`

- Default: 302 redirect to the Douyin play URL (downloaded directly from Douyin's CDN).
- `&proxy=1`: stream through Vercel as an attachment (uses Vercel bandwidth).
- Errors return plain text: 401 wrong key, 400 invalid link, 404 not found.
