import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateWebRuntimeSessionTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive: (environmentId: string | null | undefined) =>
    Boolean(environmentId?.trim())
}))

import { activateTerminalTabOnOwner } from './terminal-tab-owner-activation'

describe('activateTerminalTabOnOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tells the paired server that owns the workspace, not the focused one', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-owner')

    activateTerminalTabOnOwner('wt-1', 'web-terminal-host-tab')

    expect(mocks.getRuntimeEnvironmentIdForWorktree).toHaveBeenCalledWith({}, 'wt-1')
    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab',
      environmentId: 'env-owner'
    })
  })

  it('makes no owner round trip for a workspace this client runs', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)

    activateTerminalTabOnOwner('wt-local', 'tab-1')

    expect(mocks.activateWebRuntimeSessionTab).not.toHaveBeenCalled()
  })
})
