import { describe, expect, it } from 'vitest'
import { wslMoveCounts, type WslMoveCatalog } from './wsl-move-scope-rows'

const uncWorktreeId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\me\\app'

describe('wslMoveCounts', () => {
  it('counts a saved bridge workspace and its terminal when the listing has not caught up', () => {
    const catalog: WslMoveCatalog = {
      repos: [],
      folders: [],
      repoWorktrees: {},
      unifiedTabsByWorktree: {
        [uncWorktreeId]: [{ id: 'tab-1', entityId: 'tab-1', contentType: 'terminal' }],
        // The host copy of the same repo id: not this desktop's to move.
        'repo-1::/home/me/app': [{ id: 'tab-2', entityId: 'tab-2', contentType: 'terminal' }]
      }
    }
    expect(wslMoveCounts(catalog, [{ kind: 'repo', id: 'repo-1' }])).toEqual({
      projects: 1,
      workspaces: 1,
      terminals: 1,
      chats: 0
    })
  })
})
