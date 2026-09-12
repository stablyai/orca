export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module'

/** A definition site. line/column are 1-based. path is absolute. */
export type SymbolDef = {
  name: string
  kind: SymbolKind
  path: string
  line: number
  column: number
}

export type FindDefinitionsRequest = {
  worktreeId: string
  worktreeRoot: string
  symbol: string
}

export type FindDefinitionsResponse = {
  /** 'ready' = index answered; 'indexing' = not ready, caller should fall back. */
  status: 'ready' | 'indexing'
  definitions: SymbolDef[]
}

export const SYMBOL_INDEX_IPC = {
  findDefinitions: 'symbol-index:findDefinitions',
  ensureIndexed: 'symbol-index:ensureIndexed'
} as const

export function isSymbolDef(v: unknown): v is SymbolDef {
  if (typeof v !== 'object' || v === null) {
    return false
  }
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    typeof o.kind === 'string' &&
    typeof o.path === 'string' &&
    typeof o.line === 'number' &&
    typeof o.column === 'number'
  )
}
