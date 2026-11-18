import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../shared/git/status/git-status-types'
import { buildFolderStatusMap } from './git-path-decoration'

describe('buildFolderStatusMap', () => {
  it('decorates dirty top-level and nested submodule directories themselves, not only their ancestors', () => {
    const entries: GitStatusEntry[] = [
      {
        path: 'apps/trader',
        status: 'modified',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
      },
      {
        path: 'apps/trader/libs/core',
        status: 'untracked',
        area: 'unstaged',
        submoduleRoot: 'apps/trader',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      }
    ]

    const folders = buildFolderStatusMap(entries)

    expect(folders.get('apps')).toBe('modified')
    expect(folders.get('apps/trader')).toBe('modified')
    expect(folders.get('apps/trader/libs')).toBe('untracked')
    expect(folders.get('apps/trader/libs/core')).toBe('untracked')
  })
})
