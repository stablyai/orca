import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from './git-status-types'
import { buildFolderStatusMap } from './git-path-decoration'

describe('buildFolderStatusMap', () => {
  it('decorates a dirty submodule directory itself, not only its ancestors', () => {
    const entries: GitStatusEntry[] = [
      {
        path: 'apps/trader',
        status: 'modified',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
      }
    ]

    const folders = buildFolderStatusMap(entries)

    expect(folders.get('apps')).toBe('modified')
    expect(folders.get('apps/trader')).toBe('modified')
  })

  it('decorates a nested submodule directory read from its parent submodule', () => {
    const entries: GitStatusEntry[] = [
      {
        path: 'apps/trader/libs/core',
        status: 'modified',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true },
        submoduleRoot: 'apps/trader'
      }
    ]

    const folders = buildFolderStatusMap(entries)

    expect(folders.get('apps/trader/libs')).toBe('modified')
    expect(folders.get('apps/trader/libs/core')).toBe('modified')
  })
})
