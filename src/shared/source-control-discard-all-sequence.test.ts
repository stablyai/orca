import { describe, expect, it, vi } from 'vitest'
import {
  getDiscardAllPaths,
  getStageAllPaths,
  getUnstageAllPaths,
  isStageableStatusEntry,
  runDiscardAllForArea
} from './source-control-discard-all-sequence'
import type { GitStatusEntry } from './git-status-types'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    status: 'modified',
    area: 'unstaged',
    ...partial
  }
}

describe('getDiscardAllPaths', () => {
  it('skips non-recursing present submodules and children but keeps restorable ones', () => {
    const submodule = { commitChanged: false, trackedChanges: true, untrackedChanges: false }
    const entries: GitStatusEntry[] = [
      entry({ path: 'dirty-sub', submodule }),
      entry({ path: 'dirty-sub/file.ts', submoduleRoot: 'dirty-sub' }),
      entry({ path: 'deleted-sub', status: 'deleted', submodule }),
      entry({ path: 'recursing-sub', submodule: { ...submodule, restoreRecurses: true } }),
      entry({ path: 'parent.ts' })
    ]
    expect(getDiscardAllPaths(entries, 'unstaged')).toEqual([
      'deleted-sub',
      'recursing-sub',
      'parent.ts'
    ])
  })

  it('skips entries with an unresolved conflict', () => {
    const entries: GitStatusEntry[] = [
      entry({ path: 'clean.ts', area: 'unstaged' }),
      entry({
        path: 'conflict.ts',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      })
    ]
    // Restoring unresolved conflicts silently clears the u record before review, matching the per-row discard guard.
    expect(getDiscardAllPaths(entries, 'unstaged')).toEqual(['clean.ts'])
  })

  it('skips entries resolved locally but not yet re-staged', () => {
    const entries: GitStatusEntry[] = [
      entry({ path: 'clean.ts', area: 'unstaged' }),
      entry({
        path: 'resolved.ts',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally'
      })
    ]
    // Bulk discard must preserve local resolutions or users would have to resolve them again.
    expect(getDiscardAllPaths(entries, 'unstaged')).toEqual(['clean.ts'])
  })
})

describe('getStageAllPaths', () => {
  it('skips entries with an unresolved conflict', () => {
    const entries: GitStatusEntry[] = [
      entry({ path: 'clean.ts', area: 'unstaged' }),
      entry({
        path: 'conflict.ts',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      })
    ]
    // git add silently clears unresolved u records before review, matching the per-row Stage guard.
    expect(getStageAllPaths(entries, 'unstaged')).toEqual(['clean.ts'])
  })

  it('includes entries that are resolved locally', () => {
    const entries: GitStatusEntry[] = [
      entry({ path: 'clean.ts', area: 'unstaged' }),
      entry({
        path: 'resolved.ts',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally'
      })
    ]
    // Staging a local resolution finishes the normal conflict workflow and must remain available.
    expect(getStageAllPaths(entries, 'unstaged')).toEqual(['clean.ts', 'resolved.ts'])
  })

  it('skips submodule rows that only contain nested worktree dirtiness', () => {
    const entries: GitStatusEntry[] = [
      entry({
        path: 'nested-repo',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      }),
      entry({
        path: 'changed-gitlink',
        area: 'unstaged',
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: true }
      })
    ]
    expect(getStageAllPaths(entries, 'unstaged')).toEqual(['changed-gitlink'])
  })
})

describe('status entry stageability', () => {
  it('marks lazily-expanded submodule-internal entries as not stageable', () => {
    const innerEntry = entry({
      path: 'flutter_mine/lib/main.dart',
      area: 'unstaged',
      submoduleRoot: 'flutter_mine'
    })

    // Parent-worktree git add cannot stage inner submodule changes.
    expect(isStageableStatusEntry(innerEntry)).toBe(false)
    expect(getStageAllPaths([innerEntry], 'unstaged')).toEqual([])
  })
})

describe('getUnstageAllPaths', () => {
  it('includes staged conflict rows', () => {
    const entries: GitStatusEntry[] = [
      entry({ path: 'clean.ts', area: 'staged' }),
      entry({
        path: 'conflict.ts',
        area: 'staged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      }),
      entry({
        path: 'resolved.ts',
        area: 'staged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally'
      })
    ]
    // Unstaging conflicts safely mirrors the per-row action; no conflict filtering is needed.
    expect(getUnstageAllPaths(entries)).toEqual(['clean.ts', 'conflict.ts', 'resolved.ts'])
  })
})

describe('runDiscardAllForArea', () => {
  function makeDeps(
    overrides: {
      bulkUnstageError?: unknown
      discardManyError?: unknown
      discardOneError?: (path: string) => unknown
    } = {}
  ) {
    const bulkUnstageCalls: string[][] = []
    const discardManyCalls: string[][] = []
    const discardOneCalls: string[] = []
    const errors: unknown[] = []

    const bulkUnstage = vi.fn(async (paths: string[]) => {
      bulkUnstageCalls.push([...paths])
      if (overrides.bulkUnstageError !== undefined) {
        throw overrides.bulkUnstageError
      }
    })
    const discardMany = vi.fn(async (paths: string[]) => {
      discardManyCalls.push([...paths])
      if (overrides.discardManyError !== undefined) {
        throw overrides.discardManyError
      }
    })
    const discardOne = vi.fn(async (path: string) => {
      discardOneCalls.push(path)
      if (overrides.discardOneError) {
        const err = overrides.discardOneError(path)
        if (err !== undefined) {
          throw err
        }
      }
    })
    const onError = vi.fn((error: unknown) => {
      errors.push(error)
    })

    return {
      deps: { bulkUnstage, discardOne, onError },
      depsWithBulkDiscard: { bulkUnstage, discardMany, discardOne, onError },
      bulkUnstageCalls,
      discardManyCalls,
      discardOneCalls,
      errors,
      bulkUnstage,
      discardMany,
      discardOne,
      onError
    }
  }

  it('bulk-unstages staged paths before the per-file discard loop', async () => {
    const ctx = makeDeps()
    const result = await runDiscardAllForArea('staged', ['a.ts', 'b.ts'], ctx.deps)
    expect(result).toEqual({ discarded: ['a.ts', 'b.ts'], failed: [], aborted: false })
    expect(ctx.bulkUnstageCalls).toEqual([['a.ts', 'b.ts']])
    expect(ctx.discardOneCalls).toEqual(['a.ts', 'b.ts'])
    // Unstage before restoring worktree files or staged deltas survive as inverse changes.
    expect(ctx.bulkUnstage.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.discardOne.mock.invocationCallOrder[0]
    )
  })

  it('bulk-unstages staged paths before bulk discard', async () => {
    const ctx = makeDeps()
    const result = await runDiscardAllForArea('staged', ['a.ts', 'b.ts'], ctx.depsWithBulkDiscard)
    expect(result).toEqual({ discarded: ['a.ts', 'b.ts'], failed: [], aborted: false })
    expect(ctx.bulkUnstageCalls).toEqual([['a.ts', 'b.ts']])
    expect(ctx.discardManyCalls).toEqual([['a.ts', 'b.ts']])
    expect(ctx.discardOne).not.toHaveBeenCalled()
    // Reset the index before restoring/deleting worktree files so staged deltas cannot survive.
    expect(ctx.bulkUnstage.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.discardMany.mock.invocationCallOrder[0]
    )
  })

  it('falls back to per-file discard when bulk discard rejects', async () => {
    const ctx = makeDeps({ discardManyError: new Error('unknown method') })
    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts'], ctx.depsWithBulkDiscard)
    expect(result).toEqual({ discarded: ['a.ts', 'b.ts'], failed: [], aborted: false })
    expect(ctx.discardManyCalls).toEqual([['a.ts', 'b.ts']])
    expect(ctx.discardOneCalls).toEqual(['a.ts', 'b.ts'])
    expect(ctx.onError).not.toHaveBeenCalled()
  })

  it('aborts and skips the discard loop if bulk-unstage rejects', async () => {
    const error = new Error('index locked')
    const ctx = makeDeps({ bulkUnstageError: error })
    const result = await runDiscardAllForArea('staged', ['a.ts', 'b.ts'], ctx.deps)
    expect(result).toEqual({ discarded: [], failed: [], aborted: true })
    // Abort after failed unstage; restoring only the worktree would leave a mismatched staged delta.
    expect(ctx.discardOne).not.toHaveBeenCalled()
    expect(ctx.errors).toEqual([error])
  })

  it('continues past a per-file discard failure and records it in `failed`', async () => {
    const error = new Error('EPERM')
    const ctx = makeDeps({
      discardOneError: (path) => (path === 'b.ts' ? error : undefined)
    })
    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts', 'c.ts'], ctx.deps)
    expect(result).toEqual({
      discarded: ['a.ts', 'c.ts'],
      failed: ['b.ts'],
      aborted: false
    })
    expect(ctx.discardOneCalls).toEqual(['a.ts', 'b.ts', 'c.ts'])
    // Reserve aborted for failed bulk unstage so callers can distinguish no work from partial success.
    expect(ctx.errors).toEqual([error])
  })
})
