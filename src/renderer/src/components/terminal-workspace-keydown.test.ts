// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from './editor/editor-autosave'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from './use-terminal-activation-actions'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  floatingFocused: false,
  targetInsideFloatingPanel: false
}))

vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../hooks/ipc-tab-switch', () => ({
  handleSwitchRecentTab: vi.fn(),
  handleSwitchTab: vi.fn(),
  handleSwitchTabAcrossAllTypes: vi.fn(),
  handleSwitchTerminalTab: vi.fn()
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  createFloatingWorkspaceBrowserTab: vi.fn(),
  createFloatingWorkspaceMarkdownTab: vi.fn(),
  createFloatingWorkspaceTerminalTab: vi.fn(),
  handleEmptyFloatingWorkspacePanelCloseShortcut: () => false,
  isEventTargetInsideFloatingWorkspacePanel: () => mocks.targetInsideFloatingPanel,
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused,
  switchFloatingWorkspaceTab: vi.fn()
}))
vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))
vi.mock('./terminal-agent-tab-shortcut', () => ({
  resolveTerminalAgentTabShortcut: () => ({ actionId: null, agent: null })
}))

const controller = {
  activeWorktreeId: 'repo-1::/repo/worktree',
  handleCloseAllFiles: vi.fn(),
  handleCloseBrowserTab: vi.fn(),
  handleCloseFile: vi.fn(),
  handleNewAgentTab: vi.fn(),
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

  it('dispatches the save request with the resolved file id', () => {
    expect(pressCmdS()).toEqual([{ fileId: 'file-1' }])
  })

  it('resolves the floating panel editor when the panel owns the event', () => {
    mocks.targetInsideFloatingPanel = true
    mocks.state.getActiveTab = (worktreeId: string) =>
      worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        ? { contentType: 'editor', entityId: 'floating-file' }
        : null
    expect(pressCmdS()).toEqual([{ fileId: 'floating-file' }])
  })

  it('does not swallow the chord outside the workspace view', () => {
    mocks.state.activeView = 'tasks'
    expect(pressCmdS()).toEqual([])
  })
})
