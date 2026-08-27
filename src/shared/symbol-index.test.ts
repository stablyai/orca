import { describe, expect, it } from 'vitest'
import { isSymbolDef, SYMBOL_INDEX_IPC } from './symbol-index'

describe('symbol-index shared contract', () => {
  it('exposes stable IPC channel names', () => {
    expect(SYMBOL_INDEX_IPC.findDefinitions).toBe('symbol-index:findDefinitions')
    expect(SYMBOL_INDEX_IPC.ensureIndexed).toBe('symbol-index:ensureIndexed')
  })

  it('validates a SymbolDef shape', () => {
    expect(isSymbolDef({ name: 'foo', kind: 'function', path: '/a.ts', line: 1, column: 1 })).toBe(
      true
    )
    expect(isSymbolDef({ name: 'foo', kind: 'function', path: '/a.ts', line: 1 })).toBe(false)
    expect(isSymbolDef(null)).toBe(false)
  })
})
