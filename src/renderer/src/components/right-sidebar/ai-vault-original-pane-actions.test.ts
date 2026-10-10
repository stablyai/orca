// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<(workspaceId: string) => unknown>(),
  toastError: vi.fn<(message: string) => void>(),
  knownWorkspaceIds: new Set<string>()
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
    getKnownWorktreeById: (id: string) => (mocks.knownWorkspaceIds.has(id) ? { id } : undefined)
  }
  return {
    useAppStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})

import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'

describe('jumpToWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.knownWorkspaceIds.clear()
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
    mocks.knownWorkspaceIds.add('folder:folder-1')
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree('folder:folder-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each(['folder:gone', 'repo-1::/repo/gone'])(
    'reports a workspace that no longer exists (%s)',
    (id) => {
      mocks.activateAndRevealWorkspace.mockReturnValue(false)
      const { result } = renderHook(() => useAiVaultOriginalPaneActions())
      result.current.jumpToWorktree(id)
      expect(mocks.toastError).toHaveBeenCalledWith('Worktree is no longer available.')
    }
  )
})
