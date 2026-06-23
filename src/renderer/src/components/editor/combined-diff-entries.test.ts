import { describe, expect, it } from 'vitest'
import {
  getCombinedBranchEntries,
  getCombinedUncommittedEntries,
  shouldAutoReloadCombinedDiffFromGitStatus
} from './combined-diff-entries'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'

describe('getCombinedUncommittedEntries', () => {
  it('filters unresolved conflicts from live entries', () => {
    const liveEntries: GitStatusEntry[] = [
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'unresolved'
      },
      { path: 'src/ok.ts', status: 'modified', area: 'unstaged' }
    ]

    expect(getCombinedUncommittedEntries(liveEntries, undefined)).toEqual([
      { path: 'src/ok.ts', status: 'modified', area: 'unstaged' }
    ])
  })

  it('applies area filter when provided', () => {
    const liveEntries: GitStatusEntry[] = [
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged' },
      { path: 'src/untracked.ts', status: 'untracked', area: 'untracked' }
    ]

    expect(getCombinedUncommittedEntries(liveEntries, 'staged')).toEqual([
      { path: 'src/staged.ts', status: 'modified', area: 'staged' }
    ])
  })

  it('includes every area when no area filter is set', () => {
    const liveEntries: GitStatusEntry[] = [
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged' },
      { path: 'src/untracked.ts', status: 'untracked', area: 'untracked' }
    ]

    expect(getCombinedUncommittedEntries(liveEntries, undefined)).toEqual([
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged' },
      { path: 'src/untracked.ts', status: 'untracked', area: 'untracked' }
    ])
  })
})

describe('getCombinedBranchEntries', () => {
  it('uses an explicitly empty snapshot instead of falling back to live entries', () => {
    const liveEntries: GitBranchChangeEntry[] = [{ path: 'src/live.ts', status: 'modified' }]

    expect(getCombinedBranchEntries([], liveEntries)).toEqual([])
  })

  it('falls back to live entries when no snapshot exists', () => {
    const liveEntries: GitBranchChangeEntry[] = [{ path: 'src/live.ts', status: 'modified' }]

    expect(getCombinedBranchEntries(undefined, liveEntries)).toEqual(liveEntries)
  })
})

describe('shouldAutoReloadCombinedDiffFromGitStatus', () => {
  it('does not auto-reload snapshot-backed uncommitted diffs', () => {
    expect(
      shouldAutoReloadCombinedDiffFromGitStatus({
        mode: 'uncommitted',
        hasUncommittedEntriesSnapshot: true
      })
    ).toBe(false)
  })

  it('keeps the legacy live-entry uncommitted path reloadable', () => {
    expect(
      shouldAutoReloadCombinedDiffFromGitStatus({
        mode: 'uncommitted',
        hasUncommittedEntriesSnapshot: false
      })
    ).toBe(true)
  })

  it('does not use git status to reload branch or commit combined diffs', () => {
    expect(
      shouldAutoReloadCombinedDiffFromGitStatus({
        mode: 'branch',
        hasUncommittedEntriesSnapshot: false
      })
    ).toBe(false)
    expect(
      shouldAutoReloadCombinedDiffFromGitStatus({
        mode: 'commit',
        hasUncommittedEntriesSnapshot: false
      })
    ).toBe(false)
  })
})
