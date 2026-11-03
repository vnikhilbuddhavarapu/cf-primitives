import { DurableObject } from "cloudflare:workers";

// Cloudflare Developer Platform keynote deck.
//
//  * Static assets (public/) serve the deck itself.
//  * /api/ws upgrades to a WebSocket handled by a single Durable Object,
//    which powers the two live demos on the Durable Objects slides:
//    a global counter and a collaborative whiteboard. Everyone viewing
//    this deployment talks to the same object.
//
// Wire protocol (JSON text frames):
//   client -> server  { id, method, args }
//   server -> client  { id, result } | { id, error }
//   server push       { event, args }   events: counter | stroke | cleared | viewers

const COLORS = new Set(["orange", "blue", "green", "fg"]);
const MAX_STROKES = 600;
const MAX_FRAME = 256 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const stub = env.DECK.get(env.DECK.idFromName("deck"));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

export class DeckRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS strokes (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)"
      );
    });
  }

  // ---------- WebSocket plumbing (Hibernation API) ----------
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sub: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_FRAME) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const { id, method } = msg;
    const args = Array.isArray(msg.args) ? msg.args : [];
    let reply;
    try {
      reply = { id, result: await this.#dispatch(ws, method, args) };
    } catch (e) {
      reply = { id, error: String((e && e.message) || e) };
    }
    try { ws.send(JSON.stringify(reply)); } catch {}
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
    this.#broadcastViewers(ws);
  }

  async webSocketError(ws) {
    this.#broadcastViewers(ws);
  }

  async #dispatch(ws, method, args) {
    switch (method) {
      case "getLive": return this.getLive();
      case "increment": return this.increment(args[0]);
      case "resetCounter": return this.resetCounter();
      case "addStroke": return this.addStroke(args[0]);
      case "clearBoard": return this.clearBoard();
      case "subscribe":
        ws.serializeAttachment({ sub: true });
        this.#broadcastViewers();
        return this.#subscribers().length;
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  #subscribers(exclude) {
    return this.ctx.getWebSockets().filter((w) => {
      if (w === exclude) return false;
      try { return !!(w.deserializeAttachment() || {}).sub; } catch { return false; }
    });
  }

  #broadcast(event, args, exclude) {
    const frame = JSON.stringify({ event, args });
    for (const w of this.#subscribers(exclude)) {
      try { w.send(frame); } catch {}
    }
  }

  #broadcastViewers(exclude) {
    this.#broadcast("viewers", [this.#subscribers(exclude).length], exclude);
  }

  // ---------- live demos ----------
  async getLive() {
    const count = (await this.ctx.storage.get("count")) || 0;
    const rows = this.ctx.storage.sql.exec("SELECT data FROM strokes ORDER BY id").toArray();
    const strokes = [];
    for (const r of rows) {
      try { strokes.push(JSON.parse(r.data)); } catch {}
    }
    return { count, strokes, viewers: this.#subscribers().length };
  }

  async increment(by = 1) {
    const step = Math.max(-1000, Math.min(1000, Math.trunc(Number(by) || 1)));
    const count = ((await this.ctx.storage.get("count")) || 0) + step;
    await this.ctx.storage.put("count", count);
    this.#broadcast("counter", [count]);
    return count;
  }

  async resetCounter() {
    await this.ctx.storage.put("count", 0);
    this.#broadcast("counter", [0]);
    return 0;
  }

  async addStroke(stroke) {
    const clean = sanitizeStroke(stroke);
    if (!clean) return false;
    this.ctx.storage.sql.exec("INSERT INTO strokes (data) VALUES (?)", JSON.stringify(clean));
    this.ctx.storage.sql.exec(
      "DELETE FROM strokes WHERE id NOT IN (SELECT id FROM strokes ORDER BY id DESC LIMIT ?)",
      MAX_STROKES
    );
    this.#broadcast("stroke", [clean]);
    return true;
  }

  async clearBoard() {
    this.ctx.storage.sql.exec("DELETE FROM strokes");
    this.#broadcast("cleared", []);
    return true;
  }
}

function sanitizeStroke(s) {
  if (!s || typeof s !== "object") return null;
  const id = typeof s.id === "string" ? s.id.slice(0, 40) : "";
  const color = COLORS.has(s.color) ? s.color : "orange";
  const w = Math.max(1, Math.min(24, Number(s.w) || 4));
  if (!Array.isArray(s.pts) || s.pts.length < 2 || s.pts.length > 1600) return null;
  const pts = [];
  for (const v of s.pts) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    pts.push(Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000);
  }
  if (pts.length % 2) pts.pop();
  return { id, color, w, pts };
}
