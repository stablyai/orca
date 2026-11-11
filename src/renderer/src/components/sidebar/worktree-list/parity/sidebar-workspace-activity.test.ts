import { describe, expect, it } from 'vitest'

import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { toLocallyOwnedRows } from './sidebar-workspace-activity.test-fixture'

describe('toLocallyOwnedRows', () => {
  it('leaves out an id a paired server also lists, since bare-id activity names no one host', () => {
    const state = {
      ...useAppStore.getState(),
      repos: [],
      folderWorkspaces: [],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('local-only', 'Local', { hostId: 'local' }),
          makeWorktree('shared', 'Local twin', { hostId: 'local' }),
          makeWorktree('shared', 'Server twin', { hostId: 'runtime:box' }),
          makeWorktree('server-only', 'Server', { hostId: 'runtime:box' })
        ]
      }
    }
    const values = new Map(['local-only', 'shared', 'server-only', 'unknown'].map((id) => [id, id]))
    expect([...toLocallyOwnedRows(state, values).keys()]).toEqual(['local-only'])
  })
})
