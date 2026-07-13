import { describe, expect, it, vi } from 'vitest'
import type { FindDefinitionsResponse, SymbolDef } from '../../../../shared/symbol-index'
import { runGoToDefinition } from './go-to-definition-controller'

const target: SymbolDef = { name: 'foo', kind: 'function', path: '/b.ts', line: 3, column: 2 }

function ctx(overrides: Partial<Parameters<typeof runGoToDefinition>[0]> = {}) {
  return {
    worktreeId: 'w1',
    worktreeRoot: '/w',
    currentPath: '/a.ts',
    currentLine: 1,
    symbol: 'foo',
    find: vi.fn(async (): Promise<FindDefinitionsResponse> => ({ status: 'ready', definitions: [target] })),
    openAt: vi.fn(),
    peek: vi.fn(),
    fallback: vi.fn(),
    ...overrides
  }
}

describe('runGoToDefinition', () => {
  it('opens the single definition', async () => {
    const c = ctx()
    await runGoToDefinition(c)
    expect(c.openAt).toHaveBeenCalledWith(target)
    expect(c.fallback).not.toHaveBeenCalled()
  })

  it('falls back when no symbol under cursor', async () => {
    const c = ctx({ symbol: null })
    await runGoToDefinition(c)
    expect(c.find).not.toHaveBeenCalled()
    expect(c.fallback).toHaveBeenCalledOnce()
  })

  it('falls back when worktree is missing', async () => {
    const c = ctx({ worktreeId: null })
    await runGoToDefinition(c)
    expect(c.fallback).toHaveBeenCalledOnce()
  })

  it('peeks on multiple definitions', async () => {
    const second: SymbolDef = { ...target, path: '/c.ts', line: 9 }
    const c = ctx({
      find: vi.fn(
        async (): Promise<FindDefinitionsResponse> => ({
          status: 'ready',
          definitions: [target, second]
        })
      )
    })
    await runGoToDefinition(c)
    expect(c.peek).toHaveBeenCalledWith([target, second])
  })

  it('falls back when the index reports indexing', async () => {
    const c = ctx({
      find: vi.fn(
        async (): Promise<FindDefinitionsResponse> => ({ status: 'indexing', definitions: [] })
      )
    })
    await runGoToDefinition(c)
    expect(c.fallback).toHaveBeenCalledOnce()
  })
})
