const SYMBOL_ID_RE = /^([a-z][a-z0-9_-]{1,19}):([A-Za-z0-9._\-&]{1,40})$/;

export function parseSymbolId(id: string): { provider: string; ticker: string } | null {
  const m = SYMBOL_ID_RE.exec(id);
  return m ? { provider: m[1]!, ticker: m[2]! } : null;
}

export const isSymbolId = (id: unknown): id is string => typeof id === 'string' && SYMBOL_ID_RE.test(id);
