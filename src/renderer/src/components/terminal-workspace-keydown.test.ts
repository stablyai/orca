// @vitest-environment happy-dom

import type * as WorktreeActivation from '@/lib/workspace/activation/worktree-activation'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../hooks/ipc-tab-switch'
import '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'
import '@/components/floating-terminal/workspace/floating-workspace-tab-creation'
import '@/lib/notifications/terminal-shortcut-capture-notification'
import '@/lib/workspace/tabs/workspace-tab-commands'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/workspace/identity/floating-workspace-id'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from './editor/autosave/editor-autosave'
import '@/store/testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../store/slices/tabs/tab-group.test-fixture'
import { renderHook } from '@testing-library/react'
import { TAB_MOVE_TO_SPLIT_ACTIONS } from '../../../shared/keybindings/tab-move-to-split-definitions'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { useFloatingTerminalGlobalShortcutListeners } from './floating-terminal/shortcuts/use-floating-terminal-global-shortcut-listeners'
import '@/store/repos/repo.test-fixture'
import '@/store/slices/worktrees/worktree.test-fixture'

import './agent/launch-menu/agent-menu-shortcut-labels'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from './use-terminal-activation-actions'
import type { KeybindingOverrides } from '../../../shared/keybindings/types'
import type * as AgentTabShortcuts from './terminal-agent-tab-shortcut'

import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import './use-terminal-bulk-close-actions'

const confirmBulkClose = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('./confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmBulkClose
}))

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  closeTerminalTab: vi.fn(),
  closeStructuredAgentSession: vi.fn(async () => 'closed'),
  callRuntimeRpc: vi.fn(async () => ({ ok: true })),
  cancelStructuredAgentLaunch: vi.fn(),
  structuredSessionBusy: vi.fn<() => boolean>(),
  floatingFocused: false,
  targetInsideFloatingPanel: false,
  resolveAgentShortcut: vi.fn<
    (
      args: Parameters<typeof AgentTabShortcuts.resolveTerminalAgentTabShortcut>[0]
    ) => TerminalAgentTabShortcut
  >(() => ({ actionId: null, agent: null })),
  actualResolveAgentShortcut: vi.fn<typeof AgentTabShortcuts.resolveTerminalAgentTabShortcut>(),
  launchAgentInNewTab: vi.fn()
}))

vi.mock('@/lib/agent-session/structured-agent-session-busy', async () => ({
  admitStructuredAgentSession: (
    await import('@/store/slices/agent-status/structured-session-admission.test-fixture')
  ).admissionFromBusy(mocks.structuredSessionBusy)
}))

vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeActivation>()),
  activateAndRevealWorkspace: vi.fn()
}))

vi.mock('../store/index', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../hooks/ipc-tab-switch', () => ({
  handleSwitchRecentTab: vi.fn(),
  handleSwitchTab: vi.fn(),
  handleSwitchTabAcrossAllTypes: vi.fn(),
  handleSwitchTerminalTab: vi.fn()
}))
vi.mock('@/components/floating-terminal/workspace/floating-workspace-terminal-actions', () => ({
  handleEmptyFloatingWorkspacePanelCloseShortcut: () => false,
  isEventTargetInsideFloatingWorkspacePanel: () => mocks.targetInsideFloatingPanel,
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused,
  isFloatingWorkspaceTerminalInputTarget: () => false,
  switchFloatingWorkspaceTab: vi.fn()
}))
vi.mock('@/lib/keyboard/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/components/floating-terminal/workspace/floating-workspace-tab-creation', () => ({
  createFloatingWorkspaceBrowserTab: vi.fn(),
  createFloatingWorkspaceMarkdownTab: vi.fn(),
  createFloatingWorkspaceTerminalTab: vi.fn()
}))
vi.mock('@/lib/notifications/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))
vi.mock('./terminal-agent-tab-shortcut', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentTabShortcuts>()
  mocks.actualResolveAgentShortcut.mockImplementation(actual.resolveTerminalAgentTabShortcut)
  return { ...actual, resolveTerminalAgentTabShortcut: mocks.resolveAgentShortcut }
})
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launchAgentInNewTab
}))

vi.mock('./terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.closeTerminalTab }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', () => ({
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))
vi.mock('@/runtime/rpc/targets/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))
vi.mock('@/runtime/browser/closing/browser-workspace-tab-close', () => ({
  closeBrowserWorkspaceTabOnHosts: () => ({ closesLocally: true, removesVisibleTab: true })
}))
vi.mock('../store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))
vi.mock('../runtime/web-session-tabs-sync/placement/web-runtime-tab-move-mirror', () => ({
  mirrorWebRuntimeTabMove: vi.fn()
}))

const controller = {
  activeWorktreeId: 'repo-1::/repo/worktree',
  handleCloseAllFiles: vi.fn(),
  handleCloseBrowserTab: vi.fn(),
  handleCloseFile: vi.fn(),
  handleNewBrowserTab: vi.fn(),
  handleNewFile: vi.fn(),
  handleNewSimulatorTab: vi.fn(),
  handleNewTab: vi.fn(),
  keybindings: undefined,
  mobileEmulatorEnabled: false,
  terminalShortcutPolicy: 'orca-first'
} as unknown as TerminalActivationController

function pressCmdS(): (EditorRequestCmdSaveDetail | undefined)[] {
  const details: (EditorRequestCmdSaveDetail | undefined)[] = []
  const listener = (event: Event): void => {
    details.push((event as CustomEvent<EditorRequestCmdSaveDetail>).detail ?? undefined)
  }
  window.addEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, listener)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })
  Object.defineProperty(event, 'target', { value: target })
  try {
    handleTerminalWorkspaceKeyDown(event, controller, 'darwin')
  } finally {
    window.removeEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, listener)
    target.remove()
  }
  return details
}

describe('handleTerminalWorkspaceKeyDown editor.save', () => {
  beforeEach(() => {
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
    mocks.state = {
      activeView: 'terminal',
      activeTabType: 'editor',
      activeFileId: 'file-1',
      getActiveTab: () => null
    }
  })

  it('resolves the floating panel editor when the panel owns the event', () => {
    mocks.targetInsideFloatingPanel = true
    mocks.state.getActiveTab = (worktreeId: string) =>
      worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        ? { contentType: 'editor', entityId: 'floating-file' }
        : null
    expect(pressCmdS()).toEqual([{ fileId: 'floating-file' }])
  })
})

describe('tab.moveToSplit*', () => {
  const worktreeId = 'repo-1::/repo/worktree'
  const dropUnifiedTab = vi.fn(() => true)
  const arrowKeys = { right: 'ArrowRight', left: 'ArrowLeft', down: 'ArrowDown', up: 'ArrowUp' }
  const keybindings: KeybindingOverrides = {}
  for (const { direction, id } of TAB_MOVE_TO_SPLIT_ACTIONS) {
    keybindings[id] = [`Mod+Alt+Shift+${arrowKeys[direction]}`]
  }
  const boundController: TerminalActivationController = { ...controller, keybindings }

  function seed(tabOrder: string[], groupsWorktreeId = worktreeId): void {
    mocks.state = {
      activeView: 'terminal',
      activeWorktreeId: worktreeId,
      activeGroupIdByWorktree: { [groupsWorktreeId]: 'g' },
      groupsByWorktree: {
        [groupsWorktreeId]: [
          makeTabGroup({ id: 'g', worktreeId: groupsWorktreeId, activeTabId: 'a', tabOrder })
        ]
      },
      unifiedTabsByWorktree: {
        [groupsWorktreeId]: tabOrder.map((id) =>
          makeUnifiedTab({ id, worktreeId: groupsWorktreeId, groupId: 'g', createdAt: 0 })
        )
      },
      keybindings,
      dropUnifiedTab
    }
  }

  function chord(direction: keyof typeof arrowKeys): KeyboardEvent {
    return new KeyboardEvent('keydown', {
      key: arrowKeys[direction],
      code: arrowKeys[direction],
      metaKey: true,
      altKey: true,
      shiftKey: true,
      cancelable: true
    })
  }

  function press(direction: keyof typeof arrowKeys): KeyboardEvent {
    const event = chord(direction)
    handleTerminalWorkspaceKeyDown(event, boundController, 'darwin')
    return event
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
  })

  it.each(TAB_MOVE_TO_SPLIT_ACTIONS.map(({ direction }) => direction))(
    'moves the active tab into a new split %s',
    (direction) => {
      seed(['a', 'b'])
      expect(press(direction).defaultPrevented).toBe(true)
      expect(dropUnifiedTab).toHaveBeenCalledWith('a', { groupId: 'g', splitDirection: direction })
    }
  )

  it('lets the chord fall through when the active tab is alone in its group', () => {
    seed(['a'])
    expect(press('down').defaultPrevented).toBe(false)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
  })

  it('lets the chord fall through while Settings hides the mounted workbench', () => {
    seed(['a', 'b'])
    mocks.state.activeView = 'settings'
    expect(press('down').defaultPrevented).toBe(false)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
  })

  it('still reorders with tab.moveRight, which shares the tab-move handler', () => {
    seed(['a', 'b'])
    const reorderUnifiedTabs = vi.fn()
    Object.assign(mocks.state, {
      tabsByWorktree: { [worktreeId]: [{ id: 'a' }, { id: 'b' }] },
      tabBarOrderByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      reorderUnifiedTabs
    })
    const event = new KeyboardEvent('keydown', {
      key: ']',
      code: 'BracketRight',
      metaKey: true,
      cancelable: true
    })
    const controllerWithMove: TerminalActivationController = {
      ...controller,
      keybindings: { 'tab.moveRight': ['Mod+BracketRight'] }
    }
    handleTerminalWorkspaceKeyDown(event, controllerWithMove, 'darwin')
    expect(event.defaultPrevented).toBe(true)
    expect(reorderUnifiedTabs).toHaveBeenCalledWith('g', ['b', 'a'])
  })

  it('moves the floating panel tab when the panel owns the event', () => {
    seed(['a', 'b'], FLOATING_TERMINAL_WORKTREE_ID)
    mocks.targetInsideFloatingPanel = true
    mocks.state.activeView = 'settings'
    expect(press('right').defaultPrevented).toBe(true)
    expect(dropUnifiedTab).toHaveBeenCalledWith('a', { groupId: 'g', splitDirection: 'right' })
  })

  describe('with the floating panel listener mounted', () => {
    function mountFloatingListener(): () => void {
      const { unmount } = renderHook(() =>
        useFloatingTerminalGlobalShortcutListeners({
          panelRef: { current: null },
          doubleTapDetectorRef: { current: null },
          floatingShortcutListenersRef: {
            current: {
              activateFloatingItem: vi.fn(),
              closeFloatingItemConfirmed: vi.fn(),
              handleFloatingPanelShortcutAction: () => 'unmatched',
              visibleFloatingTabOrder: []
            }
          },
          open: true
        })
      )
      return unmount
    }
    const workspaceListener = (event: KeyboardEvent): void =>
      handleTerminalWorkspaceKeyDown(event, boundController, 'darwin')

    beforeEach(() => {
      seed(['a', 'b'], FLOATING_TERMINAL_WORKTREE_ID)
      mocks.targetInsideFloatingPanel = true
    })

    it('moves the floating tab on its own', () => {
      const unmount = mountFloatingListener()
      const event = chord('up')
      window.dispatchEvent(event)
      unmount()
      expect(event.defaultPrevented).toBe(true)
      expect(dropUnifiedTab).toHaveBeenCalledWith('a', { groupId: 'g', splitDirection: 'up' })
    })

    it.each([
      ['workspace listener first', true],
      ['floating listener first', false]
    ])('moves the tab once with both listeners (%s)', (_order, workspaceFirst) => {
      if (workspaceFirst) {
        addAppKeyListener('keydown', workspaceListener)
      }
      const unmount = mountFloatingListener()
      if (!workspaceFirst) {
        addAppKeyListener('keydown', workspaceListener)
      }
      window.dispatchEvent(chord('down'))
      unmount()
      removeAppKeyListener('keydown', workspaceListener)
      expect(dropUnifiedTab).toHaveBeenCalledTimes(1)
    })
  })
})
