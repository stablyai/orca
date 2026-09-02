import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateWebRuntimeSessionTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  focusGroup: vi.fn(),
  activateTab: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      focusGroup: mocks.focusGroup,
      activateTab: mocks.activateTab,
      setActiveTab: mocks.setActiveTab,
      setActiveTabType: mocks.setActiveTabType
    })
  }
}))

import { activateCanvasTerminal } from './activate-canvas-terminal'

const target = {
  worktreeId: 'worktree-1',
  groupId: 'group-1',
  unifiedTabId: 'unified-1',
  terminalTabId: 'terminal-1'
}

describe('activateCanvasTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('environment-1')
  })

  it("selects the terminal through Orca's canonical group and tab state", () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)

    activateCanvasTerminal(target)

    expect(mocks.focusGroup).toHaveBeenCalledWith('worktree-1', 'group-1')
    expect(mocks.activateTab).toHaveBeenCalledWith('unified-1')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('terminal-1')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mocks.activateWebRuntimeSessionTab).not.toHaveBeenCalled()
  })

  it('also activates the host tab for a web runtime session', () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)

    activateCanvasTerminal(target)

    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      tabId: 'terminal-1',
      environmentId: 'environment-1'
    })
  })
})
