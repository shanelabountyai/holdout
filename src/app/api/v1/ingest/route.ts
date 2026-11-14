// public: an API key with the `ingest` scope via requireApiKey (apikeys module, INV-40), not a session
import { now } from '@/core/clock';
import { ApiProblem, json, parse, problem, requireApiKey } from '@/modules/apikeys/api';
import { batchBody, ingest } from '@/lib/holdout/ingest';

// Holdout event ingest (PRD "Events", D-17). POST { events: [...] }, up to 500 per request. Not wrapped in
// idempotent(): every event carries its own `id`, so a retried batch is answered with duplicates instead of a replay.
// 200 with per-event outcomes; 400 only when the envelope itself is wrong.
export async function POST(req: Request): Promise<Response> {
  const ctx = await requireApiKey(req, 'ingest');
  if (ctx instanceof Response) return ctx;
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return problem('VALIDATION', '(body): not JSON.');
  }
  try {
    const { events } = parse(batchBody, body);
    return json(await ingest(ctx, events, now()));
  } catch (e) {
    if (e instanceof ApiProblem) return problem(e.code, e.message, e.headers);
    throw e;
  }
}
