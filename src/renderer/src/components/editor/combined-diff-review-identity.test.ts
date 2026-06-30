import { describe, expect, it } from 'vitest'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import { buildCombinedDiffEntryIdentity } from './combined-diff-review-identity'

describe('buildCombinedDiffEntryIdentity', () => {
  it('is stable for identical uncommitted entries', () => {
    const entry: GitStatusEntry = {
      path: 'src/app.ts',
      status: 'modified',
      area: 'unstaged',
      added: 2,
      removed: 1
    }

    expect(buildCombinedDiffEntryIdentity({ mode: 'uncommitted', entry })).toBe(
      buildCombinedDiffEntryIdentity({ mode: 'uncommitted', entry: { ...entry } })
    )
  })

  it('changes when uncommitted live status counts change', () => {
    const snapshot: GitStatusEntry = {
      path: 'src/app.ts',
      status: 'modified',
      area: 'unstaged',
      added: 2,
      removed: 1
    }
    const live: GitStatusEntry = { ...snapshot, added: 3 }

    expect(buildCombinedDiffEntryIdentity({ mode: 'uncommitted', entry: snapshot })).not.toBe(
      buildCombinedDiffEntryIdentity({ mode: 'uncommitted', entry: live })
    )
  })

  it('does not change for content edits with unchanged diff metadata', () => {
    const entry: GitStatusEntry = {
      path: 'src/app.ts',
      status: 'modified',
      area: 'unstaged',
      added: 2,
      removed: 1
    }

    expect(buildCombinedDiffEntryIdentity({ mode: 'uncommitted', entry })).toBe(
      buildCombinedDiffEntryIdentity({ mode: 'uncommitted', entry: { ...entry } })
    )
  })

  it('changes when branch compare oids change', () => {
    const entry: GitBranchChangeEntry = {
      path: 'src/view.ts',
      status: 'modified',
      added: 4,
      removed: 0
    }

    expect(
      buildCombinedDiffEntryIdentity({
        mode: 'branch',
        entry,
        mergeBase: 'base-a',
        headOid: 'head-a'
      })
    ).not.toBe(
      buildCombinedDiffEntryIdentity({
        mode: 'branch',
        entry,
        mergeBase: 'base-a',
        headOid: 'head-b'
      })
    )
  })

  it('changes when commit compare oids change', () => {
    const entry: GitBranchChangeEntry = { path: 'src/view.ts', status: 'modified' }

    expect(
      buildCombinedDiffEntryIdentity({
        mode: 'commit',
        entry,
        commitOid: 'commit-a',
        parentOid: 'parent-a'
      })
    ).not.toBe(
      buildCombinedDiffEntryIdentity({
        mode: 'commit',
        entry,
        commitOid: 'commit-b',
        parentOid: 'parent-a'
      })
    )
  })

  it('folds compare oids into branch entries shown in all mode', () => {
    // Why: in 'all' mode a branch entry (no `area`) must auto-reset on a base
    // bump, exercising the `mode === 'all' && !('area' in entry)` branch.
    const entry: GitBranchChangeEntry = { path: 'src/view.ts', status: 'modified' }

    expect(
      buildCombinedDiffEntryIdentity({ mode: 'all', entry, mergeBase: 'base-a', headOid: 'head-a' })
    ).not.toBe(
      buildCombinedDiffEntryIdentity({ mode: 'all', entry, mergeBase: 'base-a', headOid: 'head-b' })
    )
  })

  it('ignores compare oids for uncommitted entries shown in all mode', () => {
    // Why: uncommitted entries (with `area`) in 'all' mode are keyed by live
    // status only; a branch oid bump must not flip their identity.
    const entry: GitStatusEntry = {
      path: 'src/app.ts',
      status: 'modified',
      area: 'unstaged',
      added: 2,
      removed: 1
    }

    expect(
      buildCombinedDiffEntryIdentity({ mode: 'all', entry, mergeBase: 'base-a', headOid: 'head-a' })
    ).toBe(
      buildCombinedDiffEntryIdentity({ mode: 'all', entry, mergeBase: 'base-b', headOid: 'head-b' })
    )
  })

  it('changes when rename metadata changes', () => {
    const entry: GitBranchChangeEntry = {
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed'
    }

    expect(buildCombinedDiffEntryIdentity({ mode: 'branch', entry })).not.toBe(
      buildCombinedDiffEntryIdentity({
        mode: 'branch',
        entry: { ...entry, oldPath: 'src/older.ts' }
      })
    )
  })
})
