// @vitest-environment happy-dom

import type * as WorktreeActivation from '@/lib/workspace/activation/worktree-activation'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../lib/workspace/tabs/ipc-tab-switch'
import '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'
import '@/components/floating-terminal/workspace/floating-workspace-tab-creation'
import '@/lib/notifications/terminal-shortcut-capture-notification'
import '@/lib/workspace/tabs/workspace-tab-commands'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from '../../editor/autosave/editor-autosave'
import '@/store/testing/app-store-test-fixture'
import '@/store/repos/repo.test-fixture'
import '@/store/slices/worktrees/worktree.test-fixture'

import '../../agent/launch-menu/agent-menu-shortcut-labels'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from '../tab-lifecycle/use-terminal-activation-actions'
import type * as AgentTabShortcuts from './terminal-agent-tab-shortcut'

import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import '../tab-lifecycle/use-terminal-bulk-close-actions'

const confirmBulkClose = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('../../dismiss/confirmation/confirmation-dialog-context', () => ({
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
  launchAgentInNewTabWithOutcome: vi.fn()
}))

vi.mock('@/lib/agent-session/structured-agent-session-busy', async () => ({
  admitStructuredAgentSession: (
    await import('@/store/slices/agent-status/structured-sessions/structured-session-admission.test-fixture')
  ).admissionFromBusy(mocks.structuredSessionBusy)
}))

vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeActivation>()),
  activateAndRevealWorkspace: vi.fn()
}))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../../../lib/workspace/tabs/ipc-tab-switch', () => ({
  handleSwitchRecentTab: vi.fn(),
  handleSwitchTab: vi.fn(),
  handleSwitchTabAcrossAllTypes: vi.fn(),
  handleSwitchTerminalTab: vi.fn()
}))
vi.mock('@/components/floating-terminal/workspace/floating-workspace-terminal-actions', () => ({
  handleEmptyFloatingWorkspacePanelCloseShortcut: () => false,
  isEventTargetInsideFloatingWorkspacePanel: () => mocks.targetInsideFloatingPanel,
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused,
  switchFloatingWorkspaceTab: vi.fn()
}))
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
  launchAgentInNewTabWithOutcome: mocks.launchAgentInNewTabWithOutcome
}))

vi.mock('../tab-lifecycle/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))
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
vi.mock('../../../store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))
vi.mock('../../../runtime/web-session-tabs-sync/placement/web-runtime-tab-move-mirror', () => ({
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
