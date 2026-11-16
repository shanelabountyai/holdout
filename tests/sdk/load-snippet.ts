import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs the committed browser bundle (sdk/holdout.js) in a fresh V8 context with no Node globals: no require, process,
// Buffer or module. Only what a test passes in exists, so the bundle cannot lean on anything a browser lacks.
export type SnippetApi = {
  init(c: { experiments: { key: string; salt: string; variants: { key: string; weight: number }[] }[]; unitId: string; endpoint: string; flushMs?: number }): void;
  variant(key: string): string | null;
  track(event: string, value?: number): void;
  flush(): Promise<void>;
  pending(): number;
  assign(salt: string, unitId: string, variants: { key: string; weight: number }[]): string;
  VERSION: string;
};

export const SNIPPET_JS = () => readFileSync('sdk/holdout.js', 'utf8');

export function loadSnippet(globals: Record<string, unknown> = {}): { api: SnippetApi; context: vm.Context } {
  const context = vm.createContext({ ...globals });
  vm.runInContext(SNIPPET_JS(), context, { filename: 'sdk/holdout.js' });
  return { api: vm.runInContext('Holdout', context) as SnippetApi, context };
}
