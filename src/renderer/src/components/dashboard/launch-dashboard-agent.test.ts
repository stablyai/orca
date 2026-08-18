import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getKnownWorktreeById: vi.fn(),
  setActiveWorktree: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  getExecutionHostIdForWorktree: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: null,
      getKnownWorktreeById: mocks.getKnownWorktreeById,
      setActiveWorktree: mocks.setActiveWorktree
    })
  }
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree
}))

import { launchDashboardAgent } from './launch-dashboard-agent'

describe('launchDashboardAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getExecutionHostIdForWorktree.mockReturnValue('ssh:docs')
    mocks.getKnownWorktreeById.mockReturnValue({ id: 'folder:docs' })
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-1' })
  })

  it('activates a folder or git workspace on its execution host before launching', () => {
    expect(launchDashboardAgent({ worktreeId: 'folder:docs', agent: 'codex' })).toBe(true)
    expect(mocks.getKnownWorktreeById).toHaveBeenCalledWith('folder:docs', 'ssh:docs')
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith('folder:docs', 'ssh:docs')
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'folder:docs',
      launchSource: 'unknown'
    })
  })
})
