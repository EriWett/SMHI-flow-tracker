# SMHI Flow Tracker Deployment

This project is prepared for Cloudflare Workers with static assets:

- `public/index.html` is the browser app.
- `worker.mjs` handles `/api/search` and `/api/station/:id`.
- Favorites are stored in each visitor's browser with `localStorage`.
- SMHI responses are lightly cached in the Worker Cache API.
- `server.mjs` remains as a local fallback dev server.

## Local Cloudflare Preview

```sh
npm install
npm run dev
```

Wrangler will serve the static app and run the Worker locally.

## Deploy

```sh
npm run deploy
```

By default, `wrangler.toml` deploys to a `workers.dev` URL with:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = ["/api/*"]
```

Static asset requests are served directly by Cloudflare, while `/api/*`
requests run through the Worker proxy/cache layer.
Deployment trigger.
