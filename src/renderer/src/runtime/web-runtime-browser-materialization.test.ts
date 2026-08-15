import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { hasMaterializedWebRuntimeBrowserPage } from './web-runtime-browser-materialization'

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    browserTabsByWorktree: {
      'wt-1': [{ id: 'workspace-1', worktreeId: 'wt-1', pageIds: ['page-1'] }]
    },
    browserPagesByWorkspace: {
      'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1', worktreeId: 'wt-1' }]
    },
    remoteBrowserPageHandlesByPageId: {
      'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          entityId: 'workspace-1',
          contentType: 'browser',
          groupId: 'group-1'
        }
      ]
    },
    ...overrides
  } as AppState
}

describe('hasMaterializedWebRuntimeBrowserPage', () => {
  it('requires the exact remote owner, client workspace, unified tab, and requested group', () => {
    const materialized = state()

    expect(
      hasMaterializedWebRuntimeBrowserPage(
        materialized,
        'env-1',
        'wt-1',
        'remote-page-1',
        'group-1'
      )
    ).toBe(true)
    expect(
      hasMaterializedWebRuntimeBrowserPage(
        materialized,
        'env-1',
        'wt-1',
        'remote-page-1',
        'other-group'
      )
    ).toBe(false)
    expect(
      hasMaterializedWebRuntimeBrowserPage(
        state({ unifiedTabsByWorktree: { 'wt-1': [] } }),
        'env-1',
        'wt-1',
        'remote-page-1'
      )
    ).toBe(false)
    expect(
      hasMaterializedWebRuntimeBrowserPage(materialized, 'env-2', 'wt-1', 'remote-page-1')
    ).toBe(false)
  })
})
