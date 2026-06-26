import { describe, expect, it, vi } from 'vitest'
import {
  looksLikeDefinition,
  resolveDefinitions,
  type ResolverContext,
  type ResolverDeps
} from './definition-resolver'

const ctx: ResolverContext = {
  settings: null,
  worktreeId: 'w',
  worktreePath: '/repo',
  connectionId: undefined
}

describe('resolveDefinitions', () => {
  it('returns matching definitions only from supported files', async () => {
    const extract = vi.fn(async (_grammar: string, content: string) =>
      content === 'ts'
        ? [
            { name: 'foo', line: 3, column: 1 },
            { name: 'bar', line: 9, column: 1 }
          ]
        : [{ name: 'foo', line: 5, column: 2 }]
    )
    const deps: ResolverDeps = {
      search: async () => [
        { filePath: '/repo/a.ts', relativePath: 'a.ts' },
        { filePath: '/repo/readme.md', relativePath: 'readme.md' },
        { filePath: '/repo/b.py', relativePath: 'b.py' }
      ],
      read: async (f) => (f.relativePath === 'a.ts' ? 'ts' : 'py'),
      extract
    }
    const locs = await resolveDefinitions('foo', ctx, { deps })
    expect(locs).toEqual([
      { filePath: '/repo/a.ts', relativePath: 'a.ts', line: 3, column: 1 },
      { filePath: '/repo/b.py', relativePath: 'b.py', line: 5, column: 2 }
    ])
    expect(extract).toHaveBeenCalledTimes(2) // readme.md is unsupported, never parsed
  })

  it('restricts resolution to the same language when fromGrammar is set', async () => {
    const extract = vi.fn(async () => [{ name: 'foo', line: 1, column: 1 }])
    const deps: ResolverDeps = {
      search: async () => [
        { filePath: '/repo/a.py', relativePath: 'a.py' },
        { filePath: '/repo/b.ts', relativePath: 'b.ts' } // same name, different language
      ],
      read: async () => 'x',
      extract
    }
    const locs = await resolveDefinitions('foo', ctx, { fromGrammar: 'python', deps })
    expect(locs.map((l) => l.relativePath)).toEqual(['a.py'])
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('resolves across the TS/JS family but not into other languages', async () => {
    const extract = vi.fn(async () => [{ name: 'foo', line: 1, column: 1 }])
    const deps: ResolverDeps = {
      search: async () => [
        { filePath: '/repo/util.ts', relativePath: 'util.ts' },
        { filePath: '/repo/helper.js', relativePath: 'helper.js' },
        { filePath: '/repo/thing.py', relativePath: 'thing.py' } // different family
      ],
      read: async () => 'x',
      extract
    }
    const locs = await resolveDefinitions('foo', ctx, { fromGrammar: 'tsx', deps })
    expect(locs.map((l) => l.relativePath).sort()).toEqual(['helper.js', 'util.ts'])
    expect(extract).toHaveBeenCalledTimes(2)
  })

  it('skips files that fail to read', async () => {
    const deps: ResolverDeps = {
      search: async () => [{ filePath: '/repo/a.ts', relativePath: 'a.ts' }],
      read: async () => null,
      extract: async () => [{ name: 'foo', line: 1, column: 1 }]
    }
    expect(await resolveDefinitions('foo', ctx, { deps })).toEqual([])
  })

  it('caps the number of candidate files parsed', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      filePath: `/repo/f${i}.ts`,
      relativePath: `f${i}.ts`
    }))
    const extract = vi.fn(async () => [])
    await resolveDefinitions('foo', ctx, {
      deps: { search: async () => many, read: async () => 'x', extract }
    })
    expect(extract).toHaveBeenCalledTimes(40)
  })

  it('keeps results from other files when one file fails to parse', async () => {
    const extract = vi.fn(async (_grammar: string, content: string) => {
      if (content === 'boom') {
        throw new Error('parse failed')
      }
      return [{ name: 'foo', line: 7, column: 1 }]
    })
    const deps: ResolverDeps = {
      search: async () => [
        { filePath: '/repo/bad.py', relativePath: 'bad.py' },
        { filePath: '/repo/good.py', relativePath: 'good.py' }
      ],
      read: async (f) => (f.relativePath === 'bad.py' ? 'boom' : 'ok'),
      extract
    }
    const locs = await resolveDefinitions('foo', ctx, { fromGrammar: 'python', deps })
    expect(locs).toEqual([
      { filePath: '/repo/good.py', relativePath: 'good.py', line: 7, column: 1 }
    ])
  })

  it('ranks likely-definition files ahead of the cap', async () => {
    // 45 same-language candidates; the real definition is the LAST one, which
    // would fall outside the 40-file cap in original order.
    const files = Array.from({ length: 45 }, (_, i) => ({
      filePath: `/repo/f${i}.py`,
      relativePath: `f${i}.py`,
      defLikely: false
    }))
    files[44].defLikely = true
    const extract = vi.fn(async (_grammar: string, content: string) =>
      content === 'DEF' ? [{ name: 'foo', line: 2, column: 1 }] : []
    )
    const deps: ResolverDeps = {
      search: async () => files,
      read: async (f) => (f.relativePath === 'f44.py' ? 'DEF' : 'ref'),
      extract
    }
    const locs = await resolveDefinitions('foo', ctx, { fromGrammar: 'python', deps })
    expect(locs).toEqual([{ filePath: '/repo/f44.py', relativePath: 'f44.py', line: 2, column: 1 }])
  })

  it('skips files larger than the parse cap', async () => {
    const extract = vi.fn(async () => [{ name: 'foo', line: 1, column: 1 }])
    const deps: ResolverDeps = {
      search: async () => [{ filePath: '/repo/big.py', relativePath: 'big.py' }],
      read: async () => 'x'.repeat(600 * 1024),
      extract
    }
    expect(await resolveDefinitions('foo', ctx, { fromGrammar: 'python', deps })).toEqual([])
    expect(extract).not.toHaveBeenCalled() // too large to parse on the UI thread
  })

  it('bails after searching when the cancellation token is already requested', async () => {
    const search = vi.fn(async () => [{ filePath: '/repo/a.ts', relativePath: 'a.ts' }])
    const extract = vi.fn(async () => [{ name: 'foo', line: 1, column: 1 }])
    const locs = await resolveDefinitions('foo', ctx, {
      deps: { search, read: async () => 'x', extract },
      token: { isCancellationRequested: true }
    })
    expect(locs).toEqual([])
    expect(search).toHaveBeenCalledTimes(1)
    expect(extract).not.toHaveBeenCalled() // never parses once cancelled
  })

  it('degrades to no results when the search RPC fails', async () => {
    const deps: ResolverDeps = {
      search: async () => {
        throw new Error('runtime RPC timed out')
      },
      read: async () => 'x',
      extract: async () => [{ name: 'foo', line: 1, column: 1 }]
    }
    await expect(resolveDefinitions('foo', ctx, { deps })).resolves.toEqual([])
  })

  it('flags definition-like match lines without misreading comparisons', () => {
    expect(looksLikeDefinition('foo', 'def foo():')).toBe(true)
    expect(looksLikeDefinition('foo', 'foo = 5')).toBe(true)
    expect(looksLikeDefinition('foo', 'foo: int = 5')).toBe(true)
    expect(looksLikeDefinition('foo', '    if foo == bar:')).toBe(false) // == is not assignment
    expect(looksLikeDefinition('foo', 'result = compute(foo)')).toBe(false) // pure reference
  })

  it('matches symbols containing regex metacharacters literally', () => {
    // `$` is a valid identifier char; it must not be treated as an end anchor
    expect(looksLikeDefinition('$', '$ = 5')).toBe(true)
    expect(looksLikeDefinition('$scope', '$scope: Scope = inject()')).toBe(true)
    expect(looksLikeDefinition('$', 'call($)')).toBe(false) // pure reference
  })

  it('returns empty (without searching) for an empty symbol', async () => {
    const search = vi.fn(async () => [])
    await expect(
      resolveDefinitions('', ctx, {
        deps: { search, read: async () => null, extract: async () => [] }
      })
    ).resolves.toEqual([])
    expect(search).not.toHaveBeenCalled()
  })
})
