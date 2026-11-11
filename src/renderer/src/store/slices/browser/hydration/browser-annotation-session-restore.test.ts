import { describe, expect, it, vi } from 'vitest'
import '../../../../../../shared/constants'
import { parseWorkspaceSession } from '../../../../../../shared/workspace-session/workspace-session-schema'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '@/lib/workspace/persistence/workspace-session'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { createStoreSessionMockApi } from '../../../testing/app-store-session-api.test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import { makeBrowserTab } from '../browser-tab.test-fixture'
import { makeAnnotation } from '../annotations/browser-annotation-test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createStoreSessionMockApi()

const WT = 'repo1::/path/wt1'

function createHydratedStore(session: WorkspaceSessionState) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  store.getState().hydrateBrowserSession(session)
  return store
}

describe('unsent browser notes across a restart', () => {
  it('restores a page’s unsent notes from the saved session', () => {
    const before = createHydratedStore({
      activeRepoId: 'repo1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [WT]: [makeBrowserTab({ id: 'workspace-1', worktreeId: WT, url: 'https://example.com/' })]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: WT,
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [WT]: 'workspace-1' }
    })
    before.getState().addBrowserPageAnnotation(makeAnnotation('page-1'))

    const saved = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(before.getState())))
    )
    if (!saved.ok) {
      throw new Error(saved.error)
    }
    const after = createHydratedStore(saved.value)

    expect(after.getState().browserAnnotationsByPageId).toEqual({
      'page-1': [makeAnnotation('page-1')]
    })
    expect(after.getState().browserPagesByWorkspace['workspace-1']?.[0]).not.toHaveProperty(
      'annotations'
    )
  })
})
