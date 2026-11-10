# douyin-dl (test)

Test build: paste a Douyin share link, get `video_id` and a play link.

## Deploy

1. Push this folder to a GitHub repo.
2. On vercel.com: **Add New → Project → Import** the repo. No build settings needed.
3. Functions run in Hong Kong (`hkg1`, set in `vercel.json`).

## Test

- Open the deployed site, paste a link, press **Lấy link**.
- Or call the API directly: `/api/resolve?url=https://v.douyin.com/xxxx/`

The response includes a `debug` array showing which strategy worked
(`share_page` / `detail_api`), HTTP status, body length and whether a captcha was served.
