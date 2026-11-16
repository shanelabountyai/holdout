// Runs the Holdout demo site on http://localhost:8101 (local only; never deployed). `npm run demo:site`.
//
// Environment:
//   HOLDOUT_API_KEY   an API key with the `read` and `ingest` scopes (Holdout → Settings → API keys). Required.
//   HOLDOUT_URL       Holdout's origin, default http://localhost:8100
//   DEMO_EXPERIMENT   the experiment key the buy button belongs to, default checkout-button
//   DEMO_PORT         default 8101
//   DEMO_REFRESH_MS   how often the experiment config is reloaded, default 30000
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { HoldoutServer } from '../src/sdk/server';
import { createDemoSite, MAX_BODY_BYTES } from './app';

const apiKey = process.env.HOLDOUT_API_KEY ?? '';
if (!apiKey) {
  console.error('HOLDOUT_API_KEY is required: create a key with the read and ingest scopes in Holdout (Settings → API keys).');
  process.exit(1);
}
const port = Number(process.env.DEMO_PORT ?? 8101);
const holdout = new HoldoutServer({ baseUrl: process.env.HOLDOUT_URL ?? 'http://localhost:8100', apiKey });
const handle = createDemoSite({
  holdout,
  snippetJs: readFileSync(new URL('../sdk/holdout.js', import.meta.url), 'utf8'),
  experiment: process.env.DEMO_EXPERIMENT ?? 'checkout-button',
  refreshMs: Number(process.env.DEMO_REFRESH_MS ?? 30_000),
  log: (m) => console.log(`[demo-site] ${m}`),
});

async function body(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    chunks.push(c as Buffer);
    if (size > MAX_BODY_BYTES) break; // already too large: the app answers 413, no need to read the rest
  }
  return new Uint8Array(Buffer.concat(chunks));
}

createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const r = await handle(new Request(`http://localhost:${port}${req.url ?? '/'}`, { method: req.method, headers, body: await body(req) }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`[demo-site] Northwind Roasters on http://localhost:${port} (Holdout ${process.env.HOLDOUT_URL ?? 'http://localhost:8100'})`));

// Anything still queued (Holdout was down) is retried in the background.
setInterval(() => {
  if (holdout.pending()) void holdout.flush().catch((e) => console.log(`[demo-site] flush failed: ${(e as Error).message}`));
}, 5_000).unref();
