import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  buildFileExplorerGitPathStateMap,
  selectFileExplorerGitEntryForPath
} from './file-explorer-git-path-state'

describe('file explorer git path state', () => {
  it('marks working-tree and staged-only deletions as unavailable', () => {
    const entries: GitStatusEntry[] = [
      { path: 'src/unstaged.ts', status: 'deleted', area: 'unstaged' },
      { path: 'src/staged.ts', status: 'deleted', area: 'staged' }
    ]

    expect(buildFileExplorerGitPathStateMap(entries)).toEqual(
      new Map([
        ['src/unstaged.ts', 'deleted'],
        ['src/staged.ts', 'deleted']
      ])
    )
  })

  it('keeps a recreated staged deletion available through its untracked entry', () => {
    const entries: GitStatusEntry[] = [
      { path: 'src/recreated.ts', status: 'deleted', area: 'staged' },
      { path: 'src/recreated.ts', status: 'untracked', area: 'untracked' }
    ]

    expect(buildFileExplorerGitPathStateMap(entries).has('src/recreated.ts')).toBe(false)
    expect(selectFileExplorerGitEntryForPath(entries, 'src/recreated.ts')?.area).toBe('untracked')
  })

  it('fails closed for unresolved conflicts even when the fallback status is modified', () => {
    const entry: GitStatusEntry = {
      path: 'src/conflicted.ts',
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_deleted',
      conflictStatus: 'unresolved'
    }

    expect(buildFileExplorerGitPathStateMap([entry]).get('src/conflicted.ts')).toBe(
      'unresolved-conflict'
    )
    expect(selectFileExplorerGitEntryForPath([entry], 'src/conflicted.ts')).toBe(entry)
  })

  it('selects the missing working-tree deletion before a staged entry', () => {
    const staged: GitStatusEntry = {
      path: 'src/index.ts',
      status: 'modified',
      area: 'staged'
    }
    const deleted: GitStatusEntry = {
      path: 'src/index.ts',
      status: 'deleted',
      area: 'unstaged'
    }

    expect(selectFileExplorerGitEntryForPath([staged, deleted], 'src/index.ts')).toBe(deleted)
  })
})
