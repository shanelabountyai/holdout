import { writeFileSync } from 'node:fs';
import { buildSnippet, SNIPPET_OUT } from '../src/sdk/build';

// Holdout Phase 4: writes the browser snippet bundle. Commit the result; tests/sdk/vectors.test.ts checks it is fresh.
const js = buildSnippet();
writeFileSync(SNIPPET_OUT, js);
console.log(`${SNIPPET_OUT}: ${Buffer.byteLength(js)} bytes`);
