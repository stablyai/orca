// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<(workspaceId: string) => unknown>(),
  toastError: vi.fn<(message: string) => void>(),
  folderWorkspaces: new Array<{ id: string; projectGroupId: string; executionHostId: string }>()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  findStructuredAgentSessionTab: vi.fn(() => null)
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => {
  const state = {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    get folderWorkspaces() {
      return mocks.folderWorkspaces
    }
  }
  return {
    useAppStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})

import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'

function folder(executionHostId: string) {
  return { id: 'folder-1', projectGroupId: 'group-1', executionHostId }
}

describe('jumpToWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderWorkspaces = []
  })

  it('activates folder workspaces through the workspace activator', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree('folder:folder-1')
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('leaves a refused folder to the toast folder activation already showed', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    mocks.folderWorkspaces = [folder('local')]
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree('folder:folder-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    ['folder:gone', []],
    ['repo-1::/repo/gone', []],
    // The same folder id on two hosts: activation cannot pick one and returns before any toast.
    ['folder:folder-1', [folder('local'), folder('runtime:env-2')]]
  ])('reports a workspace that is gone or has no single owner (%s)', (id, folders) => {
    mocks.folderWorkspaces = folders
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree(id)
    expect(mocks.toastError).toHaveBeenCalledWith('Worktree is no longer available.')
  })
})
