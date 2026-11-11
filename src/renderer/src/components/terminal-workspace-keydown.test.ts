// @vitest-environment happy-dom

import '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../hooks/ipc-tab-switch'
import '@/components/floating-terminal/floating-workspace-terminal-actions'
import '@/components/floating-terminal/floating-workspace-tab-creation'
import '@/lib/notifications/terminal-shortcut-capture-notification'
import '@/lib/workspace/tabs/workspace-tab-commands'
import type { Tab } from '../../../shared/tab-types'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from './editor/autosave/editor-autosave'
import '@/store/testing/app-store-test-fixture'
import '@/store/repos/repo.test-fixture'
import '@/store/slices/worktrees/worktree.test-fixture'
import './use-terminal-keyboard-shortcuts'
import './tab-bar/agent-menu-shortcut-labels'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from './use-terminal-activation-actions'
import type * as AgentTabShortcuts from './terminal-agent-tab-shortcut'

import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import './use-terminal-bulk-close-actions'
import '../store/slices/editor/types/open-file.test-fixture'
import '../store/slices/tabs/tab-group.test-fixture'

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

vi.mock('../store/index', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../hooks/ipc-tab-switch', () => ({
  handleSwitchRecentTab: vi.fn(),
  handleSwitchTab: vi.fn(),
  handleSwitchTabAcrossAllTypes: vi.fn(),
  handleSwitchTerminalTab: vi.fn()
}))
vi.mock('@/components/floating-terminal/floating-workspace-terminal-actions', () => ({
  handleEmptyFloatingWorkspacePanelCloseShortcut: () => false,
  isEventTargetInsideFloatingWorkspacePanel: () => mocks.targetInsideFloatingPanel,
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused,
  switchFloatingWorkspaceTab: vi.fn()
}))
vi.mock('@/components/floating-terminal/floating-workspace-tab-creation', () => ({
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

describe('tab.close uses the unified active tab', () => {
  const worktreeId = controller.activeWorktreeId!
  let tab: Tab
  const closeUnifiedTab = vi.fn()
  const closeFile = vi.fn()
  const closeBrowserTab = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.structuredSessionBusy.mockReturnValue(false)
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
    tab = {
      id: 'chat-tab',
      entityId: 'chat-session',
      worktreeId,
      groupId: 'right-group',
      contentType: 'agent-session',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    mocks.state = {
      activeView: 'terminal',
      activeWorktreeId: worktreeId,
      settings: getDefaultSettings('/tmp/pr-34236-keyboard'),
      // The old terminal mirror can lag behind focus in a split group.
      activeTabType: 'terminal',
      activeTabId: 'other-terminal',
      activeFileId: 'other-file',
      activeBrowserTabId: 'other-browser',
      getActiveTab: () => tab,
      unifiedTabsByWorktree: { [worktreeId]: [tab] },
      openFiles: [],
      editorBufferIdOf: {},
      editorBufferViews: {},
      browserPagesByWorkspace: {},
      closeUnifiedTab,
      closeFile,
      closeBrowserTab,
      reconcileWorktreeTabModel: () => ({ renderableTabCount: 1 }),
      requestPinnedTabCloseConfirm: vi.fn(),
      setActiveWorktree: vi.fn()
    }
  })

  afterEach(() => {
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
  })

  it('leaves the chord to an agent terminal preview dialog over a workspace editor', () => {
    tab.contentType = 'editor'
    const preview = document.createElement('div')
    preview.setAttribute('data-agent-terminal-preview', '')
    const target = document.createElement('textarea')
    target.classList.add('xterm-helper-textarea')
    preview.appendChild(target)
    const event = new KeyboardEvent('keydown', { key: 'w', metaKey: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: target })
    handleTerminalWorkspaceKeyDown(event, controller, 'darwin')
    expect(event.defaultPrevented).toBe(false)
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })
})
