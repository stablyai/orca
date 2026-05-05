import { describe, expect, it } from 'vitest'
import { getCombinedUncommittedEntries } from './combined-diff-entries'
import type { GitStatusEntry } from '../../../../shared/types'

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

  it('excludes untracked entries when no area filter is set', () => {
    const liveEntries: GitStatusEntry[] = [
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged' },
      { path: 'src/untracked.ts', status: 'untracked', area: 'untracked' }
    ]

    expect(getCombinedUncommittedEntries(liveEntries, undefined)).toEqual([
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged' }
    ])
  })
})
