// Runtime shim so the deck's client.js runs unchanged outside the Gadgets
// platform. It provides the two globals the deck expects:
//
//   RpcTarget  – base class for the live-demo callback object
//   gadget     – the "server" API. Live-demo calls go over a WebSocket to the
//                DeckRoom Durable Object (/api/ws); presenter prefs (theme,
//                current slide) are kept in this browser's localStorage so
//                viewers of a public deployment don't overwrite each other.
(() => {
  globalThis.RpcTarget = class RpcTarget {};

  // ---------- per-browser prefs ----------
  const PREFS_KEY = "cf-primitives:prefs";
  const readPrefs = () => {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch {}
    return {
      theme: p.theme === "light" ? "light" : "dark",
      slide: Number.isInteger(p.slide) && p.slide >= 0 ? p.slide : 0,
    };
  };
  const writePrefs = (patch = {}) => {
    const cur = readPrefs();
    if (patch.theme === "light" || patch.theme === "dark") cur.theme = patch.theme;
    if (Number.isInteger(patch.slide) && patch.slide >= 0 && patch.slide < 500) cur.slide = patch.slide;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(cur)); } catch {}
    return cur;
  };

  // ---------- WebSocket RPC to the Durable Object ----------
  let ws = null;
  let open = false;
  let seq = 0;
  let backoff = 500;
  let queue = [];
  const pending = new Map();
  const subs = new Set();

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws = sock;
    sock.onopen = () => {
      open = true;
      backoff = 500;
      for (const frame of queue) sock.send(frame);
      queue = [];
    };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.event) {
        for (const cb of subs) {
          const fn = cb[m.event];
          if (typeof fn === "function") {
            try { fn.apply(cb, m.args || []); } catch (err) { console.warn(err); }
          }
        }
        return;
      }
      const p = pending.get(m && m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      open = false;
      queue = [];
      for (const p of pending.values()) p.reject(new Error("connection lost"));
      pending.clear();
      // Tell subscribers the link dropped; the deck re-subscribes on its own.
      const old = Array.from(subs);
      subs.clear();
      for (const cb of old) {
        try { cb[Symbol.dispose] && cb[Symbol.dispose](); } catch {}
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
  }

  function call(method, args = []) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ id, method, args });
      if (open && ws) ws.send(frame);
      else queue.push(frame);
    });
  }

  globalThis.gadget = {
    getPrefs: async () => readPrefs(),
    setPrefs: async (patch) => writePrefs(patch),
    getLive: () => call("getLive"),
    increment: (by) => call("increment", [by]),
    resetCounter: () => call("resetCounter"),
    addStroke: (stroke) => call("addStroke", [stroke]),
    clearBoard: () => call("clearBoard"),
    subscribe: (cb) => { subs.add(cb); return call("subscribe"); },
  };

  connect();
})();
