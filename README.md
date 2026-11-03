# Cloudflare Developer Platform – Primitives for what's next

A keynote deck about the Cloudflare Developer Platform, packaged as a single Cloudflare Worker.

- **The deck** is a static web app: `public/index.html` + `public/client.js`, rendered on a fixed 1920×1080 canvas that scales to any screen, with dark/light themes.
- **The live demos** on the Durable Objects slides are real. A global counter and a shared whiteboard are backed by one Durable Object (`DeckRoom`), so everyone who opens your deployment can join in from their phone.

## Deploy

You need a Cloudflare account (the free plan is fine) and Node.js 18+.

```sh
npm install
npx wrangler login      # one-time, opens the browser
npx wrangler deploy
```

Wrangler prints your URL (`https://cf-primitives.<your-subdomain>.workers.dev`). The first deploy also creates the Durable Object class from the `v1` migration in `wrangler.jsonc`.

**Or deploy from Git:** in the Cloudflare dashboard go to **Workers & Pages → Create → Import a repository**, pick this repo, and keep the default deploy command (`npx wrangler deploy`). Every push to `main` then redeploys.

## Run locally

```sh
npm run dev
```

Opens on http://localhost:8787 with a local Durable Object, so the counter and whiteboard work offline.

## Presenting

- Navigate with **← / →** (or PageUp/PageDown), or the dots and arrows in the footer.
- The theme toggle is in the footer.
- Theme and current slide are remembered **per browser**, so audience members viewing the same URL don't move your slides.
- The counter, whiteboard and viewer count are **shared** across everyone on the deployment.

## How it fits together

```
browser ──► Worker (static assets) ──► index.html, gadget-shim.js, client.js
   │
   └── WebSocket /api/ws ──► Worker ──► DeckRoom Durable Object (SQLite storage)
                                          counter · whiteboard strokes · viewers
```

| File | What it does |
| --- | --- |
| `wrangler.jsonc` | Worker config: static assets, the `DECK` Durable Object binding, and its migration. |
| `src/worker.js` | Routes `/api/ws` to the `DeckRoom` Durable Object and serves everything else from `public/`. `DeckRoom` uses the WebSocket Hibernation API, so idle connections cost nothing. |
| `public/client.js` | The deck. It was authored as a Gadget and is copied here unchanged. |
| `public/gadget-shim.js` | Provides the two globals the deck expects (`gadget`, `RpcTarget`). It forwards live-demo calls over the WebSocket and keeps preferences in `localStorage`. |

### WebSocket protocol

JSON text frames:

- **Client → server:** `{ id, method, args }`. Methods: `getLive`, `increment`, `resetCounter`, `addStroke`, `clearBoard`, `subscribe`.
- **Server → client:** `{ id, result }` or `{ id, error }`.
- **Pushes to subscribers:** `{ event, args }`. Events: `counter`, `stroke`, `cleared`, `viewers`.

The whiteboard keeps the latest 600 strokes. Stroke input is validated and clamped on the server.

## Editing the deck

Slide content lives in `public/client.js`, in the `SLIDES` array and the data constants above it. Inline formatting in slide text: `**bold**`, `*italic*`, `__underline__`, `` `code` ``, `==orange==`.
