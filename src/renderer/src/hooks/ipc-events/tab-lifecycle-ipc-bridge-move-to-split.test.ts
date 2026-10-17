import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isFloatingWorkspacePanelFocused: vi.fn(() => false),
  resolveBrowserSourcePaneColumnTarget: vi.fn(),
  moveTabToNewPaneColumn: vi.fn()
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getRuntimeEnvironmentIdForWorktree: vi.fn() }))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn()
}))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: vi.fn() }))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  createFloatingWorkspaceTerminalTab: vi.fn(),
  isFloatingWorkspacePanelFocused: mocks.isFloatingWorkspacePanelFocused,
  resolveFloatingWorkspaceBrowserWorkspaceId: vi.fn()
}))
vi.mock('@/lib/floating-workspace-guest-bridge', () => ({
  dispatchFloatingWorkspaceGuestClose: vi.fn(),
  dispatchFloatingWorkspaceGuestSelectIndex: vi.fn()
}))
vi.mock('@/components/tab-bar/active-tab-pane-column-split', () => ({
  resolveBrowserSourcePaneColumnTarget: mocks.resolveBrowserSourcePaneColumnTarget
}))
vi.mock('@/components/tab-bar/tab-move-to-pane-column', () => ({
  moveTabToNewPaneColumn: mocks.moveTabToNewPaneColumn
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ activeWorktreeId: 'wt-1' }) }
}))

import { registerTabLifecycleIpcBridge } from './tab-lifecycle-ipc-bridge'

type MoveTabToSplitPayload = { direction: 'left' | 'right' | 'up' | 'down'; sourceId: string }

function registerWithMoveListener(): (direction: MoveTabToSplitPayload['direction']) => void {
  let listener: ((payload: MoveTabToSplitPayload) => void) | undefined
  const noop = (): (() => void) => () => {}
  vi.stubGlobal('window', {
    api: {
      ui: {
        onNewTerminalTab: noop,
        onCloseActiveTab: noop,
        onCloseFloatingItem: noop,
        onSelectFloatingIndex: noop,
        onSwitchTab: noop,
        onSwitchTabAcrossAllTypes: noop,
        onSwitchRecentTab: noop,
        onSwitchTerminalTab: noop,
        onMoveTabToSplit: (cb: typeof listener) => {
          listener = cb
          return () => {}
        }
      }
    }
  })
  registerTabLifecycleIpcBridge([])
  return (direction) => listener!({ direction, sourceId: 'browser-1' })
}

describe('tab lifecycle bridge move-to-split', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isFloatingWorkspacePanelFocused.mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('moves the active tab into a new pane column in the requested direction', () => {
    mocks.resolveBrowserSourcePaneColumnTarget.mockReturnValue({
      unifiedTabId: 't1',
      groupId: 'g1'
    })
    registerWithMoveListener()('right')

    expect(mocks.resolveBrowserSourcePaneColumnTarget).toHaveBeenCalledWith('browser-1')
    expect(mocks.moveTabToNewPaneColumn).toHaveBeenCalledWith({
      unifiedTabId: 't1',
      groupId: 'g1',
      direction: 'right'
    })
  })

  it('does nothing when the tab cannot split or the floating panel owns focus', () => {
    mocks.resolveBrowserSourcePaneColumnTarget.mockReturnValue(null)
    registerWithMoveListener()('right')
    expect(mocks.moveTabToNewPaneColumn).not.toHaveBeenCalled()

    mocks.resolveBrowserSourcePaneColumnTarget.mockReturnValue({
      unifiedTabId: 't1',
      groupId: 'g1'
    })
    mocks.isFloatingWorkspacePanelFocused.mockReturnValue(true)
    registerWithMoveListener()('right')
    expect(mocks.moveTabToNewPaneColumn).not.toHaveBeenCalled()
  })

  it('tolerates a preload surface without the move listener', () => {
    vi.stubGlobal('window', {
      api: {
        ui: {
          onNewTerminalTab: () => () => {},
          onCloseActiveTab: () => () => {},
          onCloseFloatingItem: () => () => {},
          onSelectFloatingIndex: () => () => {},
          onSwitchTab: () => () => {},
          onSwitchTabAcrossAllTypes: () => () => {},
          onSwitchRecentTab: () => () => {},
          onSwitchTerminalTab: () => () => {}
        }
      }
    })
    expect(() => registerTabLifecycleIpcBridge([])).not.toThrow()
  })
})
