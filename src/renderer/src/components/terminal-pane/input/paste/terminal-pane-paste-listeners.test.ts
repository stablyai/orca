// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneCloseController } from '../../layout/close/use-terminal-pane-close-actions'
import { APP_MENU_PASTE_EVENT } from '@/lib/clipboard/menu/app-menu-paste'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      recordTerminalInput: vi.fn(),
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      runtimeStatusByEnvironmentId: new Map(),
      repos: [],
      worktreesByRepo: {}
    })
  }
}))

function createFakePane(id: number, root: HTMLElement) {
  const container = document.createElement('div')
  const element = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  element.appendChild(textarea)
  container.appendChild(element)
  root.appendChild(container)
  return {
    id,
    leafId: `leaf-${id}`,
    container,
    textarea,
    terminal: {
      modes: { bracketedPasteMode: false },
      options: {},
      element,
      paste: vi.fn(),
      input: vi.fn()
    }
  }
}

describe('registerTerminalPanePasteListeners app-menu paste', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    document.body.replaceChildren()
  })

  it('pastes into the focused pane when the manager active pane is stale (#41352)', async () => {
    Object.assign(window, {
      api: {
        ui: {
          readClipboardText: vi.fn(async () => 'echo hi'),
          readClipboardFilePaths: vi.fn(async () => []),
          clipboardHasImage: vi.fn(async () => false),
          saveClipboardImageAsTempFile: vi.fn()
        }
      }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const paneA = createFakePane(1, container)
    const paneB = createFakePane(2, container)
    let activePane = paneA
    const manager = {
      getPanes: () => [paneA, paneB],
      getActivePane: () => activePane,
      setActivePane: (id: number) => {
        activePane = id === paneB.id ? paneB : paneA
      }
    }
    const transports = new Map(
      [paneA, paneB].map((pane) => [
        pane.id,
        { getPtyId: () => `pty-${pane.id}`, isConnected: () => true }
      ])
    )
    const setTerminalError = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub supplies the controller fields the paste listeners and execution read.
    const controller = {
      cwd: '/tmp',
      forceBracketedMultilineTextPaste: false,
      keybindings: {},
      managerRef: { current: manager },
      paneTransportsRef: { current: transports },
      setTerminalError,
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    } as unknown as TerminalPaneCloseController
    cleanup = registerTerminalPanePasteListeners({
      container,
      controller,
      execution: createTerminalPanePasteExecution(controller, 'darwin'),
      isMac: true,
      shortcutPlatform: 'darwin'
    })

    // A file drop focuses the drop pane's xterm without a pointerdown, leaving pane A active.
    paneB.textarea.focus()
    window.dispatchEvent(new CustomEvent(APP_MENU_PASTE_EVENT, { cancelable: true }))

    await vi.waitFor(() => expect(paneB.terminal.paste).toHaveBeenCalledWith('echo hi'))
    expect(paneA.terminal.paste).not.toHaveBeenCalled()
    expect(setTerminalError).not.toHaveBeenCalled()
  })
})
