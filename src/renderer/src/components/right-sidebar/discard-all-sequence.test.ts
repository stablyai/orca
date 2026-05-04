import { describe, expect, it, vi } from 'vitest'
import {
  getDiscardAllPaths,
  runDiscardAllForArea,
  type DiscardAllArea
} from './discard-all-sequence'
import type { GitStatusEntry } from '../../../../shared/types'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    status: 'modified',
    area: 'unstaged',
    ...partial
  }
}

describe('getDiscardAllPaths', () => {
  it('returns only paths in the requested area', () => {
    const entries: GitStatusEntry[] = [
      entry({ path: 'a.ts', area: 'staged' }),
      entry({ path: 'b.ts', area: 'unstaged' }),
      entry({ path: 'c.ts', area: 'untracked', status: 'untracked' })
    ]
    expect(getDiscardAllPaths(entries, 'staged')).toEqual(['a.ts'])
    expect(getDiscardAllPaths(entries, 'unstaged')).toEqual(['b.ts'])
    expect(getDiscardAllPaths(entries, 'untracked')).toEqual(['c.ts'])
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
    // Why: `git restore --worktree --source=HEAD` on an unresolved conflict
    // clears the `u` record silently before the user has reviewed it, which
    // is why the per-row Stage/Discard buttons also suppress this case.
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
    // Why: discarding a locally-resolved file loses the resolution. The user
    // would have to re-resolve from scratch — treat it as too dangerous to
    // include in a bulk action.
    expect(getDiscardAllPaths(entries, 'unstaged')).toEqual(['clean.ts'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(getDiscardAllPaths([], 'staged')).toEqual([])
    expect(getDiscardAllPaths([entry({ path: 'a.ts', area: 'staged' })], 'unstaged')).toEqual([])
  })
})

describe('runDiscardAllForArea', () => {
  function makeDeps(
    overrides: {
      bulkUnstageError?: unknown
      discardOneError?: (path: string) => unknown
    } = {}
  ) {
    const bulkUnstageCalls: string[][] = []
    const discardOneCalls: string[] = []
    const errors: unknown[] = []

    const bulkUnstage = vi.fn(async (paths: string[]) => {
      bulkUnstageCalls.push([...paths])
      if (overrides.bulkUnstageError !== undefined) {
        throw overrides.bulkUnstageError
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
      bulkUnstageCalls,
      discardOneCalls,
      errors,
      bulkUnstage,
      discardOne,
      onError
    }
  }

  it('no-ops when the path list is empty', async () => {
    const ctx = makeDeps()
    const result = await runDiscardAllForArea('staged', [], ctx.deps)
    expect(result).toEqual({ discarded: [], aborted: false })
    expect(ctx.bulkUnstage).not.toHaveBeenCalled()
    expect(ctx.discardOne).not.toHaveBeenCalled()
  })

  it('discards unstaged paths one-by-one without bulk-unstaging', async () => {
    const ctx = makeDeps()
    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts'], ctx.deps)
    expect(result).toEqual({ discarded: ['a.ts', 'b.ts'], aborted: false })
    expect(ctx.bulkUnstage).not.toHaveBeenCalled()
    expect(ctx.discardOneCalls).toEqual(['a.ts', 'b.ts'])
  })

  it('discards untracked paths one-by-one without bulk-unstaging', async () => {
    const ctx = makeDeps()
    const result = await runDiscardAllForArea('untracked', ['new.ts'], ctx.deps)
    expect(result).toEqual({ discarded: ['new.ts'], aborted: false })
    expect(ctx.bulkUnstage).not.toHaveBeenCalled()
    expect(ctx.discardOneCalls).toEqual(['new.ts'])
  })

  it('bulk-unstages staged paths before the per-file discard loop', async () => {
    const ctx = makeDeps()
    const result = await runDiscardAllForArea('staged', ['a.ts', 'b.ts'], ctx.deps)
    expect(result).toEqual({ discarded: ['a.ts', 'b.ts'], aborted: false })
    expect(ctx.bulkUnstageCalls).toEqual([['a.ts', 'b.ts']])
    expect(ctx.discardOneCalls).toEqual(['a.ts', 'b.ts'])
    // Why: bulk unstage MUST happen strictly before any discard, otherwise
    // the index would still hold the staged delta when the worktree was
    // reset and the files would reappear as inverse changes.
    expect(ctx.bulkUnstage.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.discardOne.mock.invocationCallOrder[0]
    )
  })

  it('aborts and skips the discard loop if bulk-unstage rejects', async () => {
    const error = new Error('index locked')
    const ctx = makeDeps({ bulkUnstageError: error })
    const result = await runDiscardAllForArea('staged', ['a.ts', 'b.ts'], ctx.deps)
    expect(result).toEqual({ discarded: [], aborted: true })
    // Why: a failed unstage + successful discard would leave the index with
    // the staged delta and the worktree at HEAD — a worse state than we
    // started in. The discard loop must not run.
    expect(ctx.discardOne).not.toHaveBeenCalled()
    expect(ctx.errors).toEqual([error])
  })

  it('does not invoke the error callback on a happy-path staged run', async () => {
    const ctx = makeDeps()
    await runDiscardAllForArea('staged', ['a.ts'], ctx.deps)
    expect(ctx.onError).not.toHaveBeenCalled()
  })

  it('does not bulk-unstage for non-staged areas even if the dep is provided', async () => {
    const ctx = makeDeps()
    const areas: DiscardAllArea[] = ['unstaged', 'untracked']
    for (const area of areas) {
      await runDiscardAllForArea(area, ['x.ts'], ctx.deps)
    }
    // Why: the unstage step is specific to the staged area's two-step
    // reset. Accidentally invoking it for unstaged/untracked would be a
    // no-op for unstaged entries but could mask a regression where staged
    // entries leak into those paths.
    expect(ctx.bulkUnstage).not.toHaveBeenCalled()
  })
})
