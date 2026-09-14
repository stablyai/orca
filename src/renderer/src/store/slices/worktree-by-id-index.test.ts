import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildByIdIndex, buildWorktreeByIdIndex } from './worktree-by-id-index'

function worktree(id: string, repoId: string): Worktree {
  return { id, repoId, path: `/repos/${repoId}/${id}`, branch: id } as Worktree
}

// Reference: the pre-change lookup these indexes replace.
function findByFlatten(worktreesByRepo: Record<string, Worktree[]>, id: string): Worktree | null {
  return (
    Object.values(worktreesByRepo)
      .flat()
      .find((entry) => entry.id === id) ?? null
  )
}

describe('buildWorktreeByIdIndex', () => {
  const worktreesByRepo = {
    repoA: [worktree('wt-1', 'repoA'), worktree('wt-2', 'repoA')],
    repoB: [worktree('wt-3', 'repoB')],
    repoC: []
  }

  // Why: the index replaces a per-iteration flatten+find, so the contract that
  // matters is that it resolves exactly what that find resolved.
  it('resolves every id identically to flatten-and-find', () => {
    for (const id of ['wt-1', 'wt-2', 'wt-3', 'missing', '']) {
      expect(buildWorktreeByIdIndex(worktreesByRepo).get(id) ?? null).toEqual(
        findByFlatten(worktreesByRepo, id)
      )
    }
  })

  it('returns undefined for an id in no repo', () => {
    expect(buildWorktreeByIdIndex(worktreesByRepo).get('nope')).toBeUndefined()
  })

  it('handles an empty map', () => {
    expect(buildWorktreeByIdIndex({}).size).toBe(0)
  })

  it('skips repos with no worktrees', () => {
    expect(buildWorktreeByIdIndex(worktreesByRepo).size).toBe(3)
  })

  // Why first-wins: Array.prototype.find returns the first match, and repo order is
  // Object.values order. A duplicate id across repos must resolve the same way.
  it('keeps the first entry when an id appears in two repos', () => {
    const duplicated = {
      repoA: [worktree('shared', 'repoA')],
      repoB: [worktree('shared', 'repoB')]
    }
    expect(buildWorktreeByIdIndex(duplicated).get('shared')?.repoId).toBe('repoA')
    expect(buildWorktreeByIdIndex(duplicated).get('shared')).toEqual(
      findByFlatten(duplicated, 'shared')
    )
  })
})

describe('buildByIdIndex', () => {
  it('resolves every id identically to find', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'c', n: 3 }
    ]
    for (const id of ['a', 'b', 'c', 'zzz']) {
      expect(buildByIdIndex(rows).get(id)).toEqual(rows.find((row) => row.id === id))
    }
  })

  it('keeps the first row when ids repeat', () => {
    const rows = [
      { id: 'dup', n: 1 },
      { id: 'dup', n: 2 }
    ]
    expect(buildByIdIndex(rows).get('dup')).toEqual(rows.find((row) => row.id === 'dup'))
    expect(buildByIdIndex(rows).get('dup')?.n).toBe(1)
  })

  it('handles an empty list', () => {
    expect(buildByIdIndex([]).size).toBe(0)
  })
})
