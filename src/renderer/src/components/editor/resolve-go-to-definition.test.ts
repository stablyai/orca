import { describe, expect, it } from 'vitest'
import type { SymbolDef } from '../../../../shared/symbol-index'
import { resolveGoToDefinition } from './resolve-go-to-definition'

const def = (path: string, line: number): SymbolDef => ({
  name: 'foo',
  kind: 'function',
  path,
  line,
  column: 1
})

describe('resolveGoToDefinition', () => {
  it('falls back when indexing or empty', () => {
    expect(resolveGoToDefinition({ status: 'indexing', definitions: [] }, '/a.ts', 1).kind).toBe('fallback')
    expect(resolveGoToDefinition({ status: 'ready', definitions: [] }, '/a.ts', 1).kind).toBe('fallback')
  })

  it('opens a single distinct definition', () => {
    const out = resolveGoToDefinition({ status: 'ready', definitions: [def('/b.ts', 4)] }, '/a.ts', 1)
    expect(out).toEqual({ kind: 'open', target: def('/b.ts', 4) })
  })

  it('peeks when multiple definitions exist', () => {
    const out = resolveGoToDefinition(
      { status: 'ready', definitions: [def('/b.ts', 4), def('/c.ts', 9)] },
      '/a.ts',
      1
    )
    expect(out.kind).toBe('peek')
  })

  it('falls back when the only hit is the cursor line itself', () => {
    const out = resolveGoToDefinition({ status: 'ready', definitions: [def('/a.ts', 7)] }, '/a.ts', 7)
    expect(out.kind).toBe('fallback')
  })
})
