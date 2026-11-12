import { describe, expect, it } from 'vitest'
import { resolveCombinedUncommittedSnapshotEntries } from './combined-diff-entries'

import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'

describe('resolveCombinedUncommittedSnapshotEntries', () => {
  it('uses live metadata when a stale snapshot area moves to a rename entry', () => {
    const snapshotEntries: GitStatusEntry[] = [
      { path: 'src/new.ts', status: 'modified', area: 'unstaged', oldPath: 'src/old-copy.ts' }
    ]
    const liveEntries: GitStatusEntry[] = [
      {
        path: 'src/new.ts',
        status: 'renamed',
        area: 'staged',
        oldPath: 'src/old.ts',
        added: 3,
        removed: 1
      }
    ]

    expect(resolveCombinedUncommittedSnapshotEntries(snapshotEntries, liveEntries)).toEqual([
      {
        path: 'src/new.ts',
        status: 'renamed',
        area: 'staged',
        oldPath: 'src/old.ts',
        added: 3,
        removed: 1
      }
    ])
  })

  it('does not remap duplicate-path snapshots to a retained fallback area', () => {
    const snapshotEntries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 },
      { path: 'src/file.ts', status: 'modified', area: 'unstaged', added: 2 }
    ]
    const retained: GitStatusEntry[] = [{ path: 'src/file.ts', status: 'modified', area: 'staged' }]

    expect(resolveCombinedUncommittedSnapshotEntries(snapshotEntries, [], retained)).toEqual([
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 }
    ])
  })

  it('does not let a retained stale area duplicate an original target area', () => {
    const snapshotEntries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'unstaged', added: 2 },
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 }
    ]
    const retained: GitStatusEntry[] = [{ path: 'src/file.ts', status: 'modified', area: 'staged' }]

    expect(resolveCombinedUncommittedSnapshotEntries(snapshotEntries, [], retained)).toEqual([
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 }
    ])
  })

  it('drops a stale snapshot area when resolving it would duplicate an existing area', () => {
    const snapshotEntries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'unstaged', added: 2 },
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 }
    ]
    const liveEntries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 6 }
    ]

    expect(resolveCombinedUncommittedSnapshotEntries(snapshotEntries, liveEntries)).toEqual([
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 }
    ])
  })

  it('keeps the original target area when it appears before a stale area', () => {
    const snapshotEntries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 },
      { path: 'src/file.ts', status: 'modified', area: 'unstaged', added: 2 }
    ]
    const liveEntries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 6 }
    ]

    expect(resolveCombinedUncommittedSnapshotEntries(snapshotEntries, liveEntries)).toEqual([
      { path: 'src/file.ts', status: 'modified', area: 'staged', added: 4 }
    ])
  })
})
