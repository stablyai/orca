import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return {
    state,
    closeOnHosts: vi.fn(),
    destroyWorkspaceWebviews: vi.fn(),
    closeBrowserTab: vi.fn(),
    closeUnifiedTab: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: mocks.destroyWorkspaceWebviews
}))
vi.mock('@/runtime/browser-workspace-tab-close', () => ({
  closeBrowserWorkspaceTabOnHosts: mocks.closeOnHosts
}))

import { closeWorkspaceBrowserTab } from './workspace-browser-tab-close'

const WORKTREE_ID = 'repo::/w'
type OwnerHost = 'local' | 'runtime:env-1'

function stateOwnedBy(hostIds: OwnerHost[], pages: { id: string }[] = []) {
  return {
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) => ({
        id: WORKTREE_ID,
        repoId: 'repo',
        hostId,
        ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-1' })
      }))
    },
    browserPagesByWorkspace: { 'browser-ws': pages },
    closeBrowserTab: mocks.closeBrowserTab,
    closeUnifiedTab: mocks.closeUnifiedTab
  }
}

describe('closeWorkspaceBrowserTab owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.closeOnHosts.mockReturnValue({
      hostEnvironmentIds: ['env-1'],
      closesLocally: false,
      removesVisibleTab: true
    })
  })

  it("closes a pageless mirror on its runtime owner's host", () => {
    mocks.state = stateOwnedBy(['runtime:env-1'])

    closeWorkspaceBrowserTab(WORKTREE_ID, 'browser-ws', 'visible-tab')

    expect(mocks.closeOnHosts).toHaveBeenCalledWith(
      expect.objectContaining({ focusedEnvironmentId: 'env-1', visibleTabId: 'visible-tab' })
    )
    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('visible-tab', undefined)
  })

  it('refuses a pageless mirror of a local twin: no host close, no local teardown', () => {
    mocks.state = stateOwnedBy(['local', 'runtime:env-1'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const plan = closeWorkspaceBrowserTab(WORKTREE_ID, 'browser-ws', 'visible-tab')

    expect(plan).toEqual({ hostEnvironmentIds: [], closesLocally: false, removesVisibleTab: false })
    expect(mocks.closeOnHosts).not.toHaveBeenCalled()
    expect(mocks.closeBrowserTab).not.toHaveBeenCalled()
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.destroyWorkspaceWebviews).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })
})
