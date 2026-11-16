// Holdout Phase 4 demo site: "Northwind Roasters", a fictional coffee shop that runs one experiment on its buy button.
// Local only (port 8101), never deployed.
//
// How the pieces fit (D-35): this server holds the Holdout API key and uses the server SDK. It renders the running
// experiments into the page; the browser snippet (sdk/holdout.js) assigns with the same function and posts events to
// this site's /collect, which stamps the visitor's unit id from its own cookie and relays them to Holdout's ingest.
// The browser never sees a key, and cannot send events for another visitor.
//
// Written against the Fetch API (Request → Response) so tests drive it without a socket; server.ts adapts node:http.
import type { HoldoutEvent, HoldoutServer } from '../src/sdk/server';

export const COOKIE = 'nw_uid';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_EVENTS = 50;
const CLIENT_ID = /^[A-Za-z0-9-]{1,40}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,100}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UID = /^[0-9a-f-]{36}$/;

/** What each variant of the demo experiment renders. Unknown variants fall back to control. */
export const BUTTONS: Record<string, { label: string; className: string }> = {
  control: { label: 'Add to cart', className: 'btn' },
  treatment: { label: 'Buy now: free shipping', className: 'btn btn-bold' },
};

export type DemoSiteOptions = {
  holdout: HoldoutServer;
  snippetJs: string;
  /** The experiment key the buy button belongs to. */
  experiment: string;
  /** How old the experiment config may get before a request reloads it (ms). */
  refreshMs?: number;
  newUnitId?: () => string;
  clock?: () => number;
  log?: (msg: string) => void;
};

type Out = { status: number; body: string; type: string; headers?: Record<string, string> };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LS = new RegExp('\\u2028', 'g');
const PS = new RegExp('\\u2029', 'g');
/** JSON inside a <script> element: `<` escaped so the data can never close the element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');

function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) {
      const val = v.join('=');
      return UID.test(val) ? val : null;
    }
  }
  return null;
}

const STYLE = `
  :root { --bg:#faf7f2; --ink:#2b2118; --muted:#6f6254; --card:#fff; --accent:#7a4a21; --line:#e7dfd4; }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); }
  header, main, footer { max-width:880px; margin:0 auto; padding:16px; }
  header { display:flex; justify-content:space-between; align-items:center; }
  header a { color:var(--muted); text-decoration:none; margin-left:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; display:grid; gap:24px; grid-template-columns:1fr; }
  @media (min-width:640px) { .card { grid-template-columns:200px 1fr; } }
  .bag { width:100%; aspect-ratio:3/4; border-radius:10px; background:linear-gradient(160deg,#a8754a,#5a3519); display:flex; align-items:center; justify-content:center; color:#fff7ec; font-weight:700; letter-spacing:.06em; }
  h1 { font-size:28px; margin:0 0 8px; } .price { font-size:20px; font-weight:600; margin:8px 0 16px; }
  .btn { font:inherit; padding:12px 20px; border-radius:8px; border:1px solid var(--accent); background:#fff; color:var(--accent); cursor:pointer; }
  .btn-bold { background:var(--accent); color:#fff; font-weight:700; }
  .note { color:var(--muted); font-size:14px; } code { background:#f1ebe2; padding:1px 5px; border-radius:4px; }
  #thanks { margin-top:12px; font-weight:600; }
`;

function shell(title: string, body: string, scripts = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<header><strong>Northwind Roasters</strong><nav><a href="/">Shop</a><a href="/server">Server-rendered</a></nav></header>
<main>${body}</main>
<footer class="note">A fictional shop for the Holdout demo. Runs locally; nothing here is deployed.</footer>
${scripts}</body></html>`;
}

function product(buttonHtml: string, extra: string): string {
  return `<div class="card"><div class="bag" aria-hidden="true">HOUSE BLEND</div><div>
<h1>House Blend, 340 g</h1><p class="note">Medium roast. Chocolate, toasted almond, a little cherry.</p>
<div class="price">$18.00</div>${buttonHtml}<div id="thanks" role="status"></div>${extra}</div></div>`;
}

export function createDemoSite(o: DemoSiteOptions) {
  const refreshMs = o.refreshMs ?? 30_000;
  const clock = o.clock ?? (() => Date.now());
  const newUnitId = o.newUnitId ?? (() => crypto.randomUUID());
  const log = o.log ?? (() => undefined);
  let loadedAt = -Infinity;

  async function config() {
    if (clock() - loadedAt >= refreshMs) {
      try {
        await o.holdout.refresh();
        loadedAt = clock();
      } catch (e) {
        log(`holdout config refresh failed, keeping the last one: ${(e as Error).message}`);
      }
    }
    return o.holdout.experiments();
  }

  function visitor(req: Request): { uid: string; setCookie: Record<string, string> } {
    const existing = cookieOf(req);
    if (existing) return { uid: existing, setCookie: {} };
    const uid = newUnitId();
    return { uid, setCookie: { 'set-cookie': `${COOKIE}=${uid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` } };
  }

  async function shop(req: Request): Promise<Out> {
    const { uid, setCookie } = visitor(req);
    const experiments = await config();
    const control = BUTTONS.control!;
    const button = `<button id="buy" class="${control.className}" data-variant="">${esc(control.label)}</button>`;
    const extra = `<p class="note">Variant: <code id="variant">loading</code>. Assigned in your browser by <code>sdk/holdout.js</code>.</p>`;
    const scripts = `<script type="application/json" id="holdout-config">${scriptJson({ experiments, unitId: uid, endpoint: '/collect', flushMs: 300 })}</script>
<script src="/holdout.js"></script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('holdout-config').textContent);
  var buttons = ${scriptJson(BUTTONS)};
  Holdout.init(cfg);
  var v = Holdout.variant(${scriptJson(o.experiment)});
  var b = buttons[v] || buttons.control;
  var el = document.getElementById('buy');
  el.textContent = b.label; el.className = b.className; el.setAttribute('data-variant', v || 'none');
  document.getElementById('variant').textContent = v || 'none (experiment not running)';
  el.addEventListener('click', function () {
    Holdout.track('purchase');
    Holdout.flush().then(function () { document.getElementById('thanks').textContent = 'Thanks! Your order is on its way.'; });
  });
})();
</script>`;
    return { status: 200, type: 'text/html; charset=utf-8', body: shell('Northwind Roasters', product(button, extra), scripts), headers: setCookie };
  }

  async function serverPage(req: Request): Promise<Out> {
    const { uid, setCookie } = visitor(req);
    await config();
    const v = o.holdout.variant(o.experiment, uid);
    const b = BUTTONS[v ?? 'control'] ?? BUTTONS.control!;
    const r = await o.holdout.flush();
    if (r.rejected.length || r.failed) log(`exposure relay: ${r.rejected.length} rejected, ${r.failed} failed`);
    const button = `<button id="buy" class="${b.className}" data-variant="${esc(v ?? 'none')}" disabled>${esc(b.label)}</button>`;
    const extra = `<p class="note">Variant: <code id="variant">${esc(v ?? 'none (experiment not running)')}</code>. Assigned on the server by the TypeScript SDK, no JavaScript in this page.</p>`;
    return { status: 200, type: 'text/html; charset=utf-8', body: shell('Northwind Roasters (server-rendered)', product(button, extra)), headers: setCookie };
  }

  /** Validates the snippet's events and rewrites them for this visitor. Returns an error string for a bad request. */
  function toHoldout(raw: unknown, uid: string): HoldoutEvent[] | string {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { events?: unknown }).events)) return 'body must be { events: [...] }';
    const events = (raw as { events: unknown[] }).events;
    if (events.length < 1 || events.length > MAX_EVENTS) return `1 to ${MAX_EVENTS} events per request`;
    const out: HoldoutEvent[] = [];
    for (const e of events) {
      if (!e || typeof e !== 'object') return 'each event must be an object';
      const x = e as Record<string, unknown>;
      if (typeof x.id !== 'string' || !CLIENT_ID.test(x.id)) return 'event id must match [A-Za-z0-9-]{1,40}';
      // Namespaced by visitor: one browser cannot collide with, or suppress, another visitor's event ids.
      const id = `${uid}.${x.id}`;
      const timestamp = typeof x.timestamp === 'string' && x.timestamp.length <= 40 ? x.timestamp : undefined;
      if (x.type === 'exposure') {
        if (typeof x.experiment !== 'string' || !KEY.test(x.experiment)) return 'exposure needs an experiment key';
        const variant = typeof x.variant === 'string' && KEY.test(x.variant) ? x.variant : undefined;
        out.push({ type: 'exposure', id, experiment: x.experiment, unitId: uid, ...(variant && { variant }), ...(timestamp && { timestamp }) });
      } else if (x.type === 'conversion') {
        if (typeof x.event !== 'string' || !EVENT_NAME.test(x.event)) return 'conversion needs an event name';
        const value = typeof x.value === 'number' && Number.isFinite(x.value) ? x.value : undefined;
        out.push({ type: 'conversion', id, event: x.event, unitId: uid, ...(value !== undefined && { value }), ...(timestamp && { timestamp }) });
      } else return 'event type must be exposure or conversion';
    }
    return out;
  }

  async function collect(req: Request): Promise<Out> {
    const uid = cookieOf(req);
    if (!uid) return { status: 400, type: 'application/json', body: JSON.stringify({ error: 'no visitor cookie; load a page first' }) };
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { status: 413, type: 'application/json', body: JSON.stringify({ error: 'body too large' }) };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { status: 400, type: 'application/json', body: JSON.stringify({ error: 'not JSON' }) };
    }
    const events = toHoldout(raw, uid);
    if (typeof events === 'string') return { status: 400, type: 'application/json', body: JSON.stringify({ error: events }) };
    o.holdout.enqueue(events);
    const r = await o.holdout.flush();
    if (r.rejected.length) log(`relay: ${r.rejected.map((x) => x.code).join(', ')}`);
    // 202 even when Holdout is down: the server SDK keeps the events for its next flush.
    return { status: 202, type: 'application/json', body: JSON.stringify({ accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected.length, queued: r.failed }) };
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let out: Out;
    try {
      if (req.method === 'GET' && url.pathname === '/') out = await shop(req);
      else if (req.method === 'GET' && url.pathname === '/server') out = await serverPage(req);
      else if (req.method === 'GET' && url.pathname === '/holdout.js') out = { status: 200, type: 'application/javascript; charset=utf-8', body: o.snippetJs };
      else if (req.method === 'GET' && url.pathname === '/health') out = { status: 200, type: 'application/json', body: JSON.stringify({ ok: true, experiments: o.holdout.experiments().length }) };
      else if (req.method === 'POST' && url.pathname === '/collect') out = await collect(req);
      else out = { status: 404, type: 'text/plain', body: 'not found' };
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      out = { status: 500, type: 'text/plain', body: 'error' };
    }
    return new Response(out.body, {
      status: out.status,
      headers: { 'content-type': out.type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store', ...out.headers },
    });
  };
}
