// public: an API key via requireApiKey (apikeys module, INV-40), not a session
import { z } from 'zod';
import { api, decodeCursor, json, limitField, page, parse, query } from '@/modules/apikeys/api';
import { runningConfig } from '@/lib/holdout/ingest';

// Assignment config for clients (D-23): running experiments with their salt and variants in the frozen order, so a
// client runs the same assign() (src/lib/exp/hash.ts) the server checks exposures with. Drafts are never listed.
const cursor = z.object({ id: z.uuid() });

export const GET = api('read', async (ctx, req) => {
  const q = parse(z.object({ limit: limitField, cursor: z.string().optional() }).strict(), query(req));
  const after = decodeCursor(cursor, q.cursor);
  const rows = await runningConfig(ctx, after?.id ?? null, q.limit + 1);
  const { data, nextCursor } = page(rows, q.limit, (x) => ({ id: x.id }));
  return json({
    data: data.map((x) => ({ key: x.key, salt: x.salt, startedAt: x.startedAt?.toISOString() ?? null, variants: x.variants })),
    nextCursor,
  });
});
