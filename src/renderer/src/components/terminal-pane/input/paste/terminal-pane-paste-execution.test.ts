// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPaneCloseController } from '../../layout/close/use-terminal-pane-close-actions'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ recordTerminalInput: vi.fn() }) }
}))

type FakePane = {
  id: number
  leafId: string
  container: HTMLDivElement
  textarea: HTMLTextAreaElement
  terminal: {
    modes: { bracketedPasteMode: boolean }
    options: Record<string, unknown>
    element: HTMLDivElement
    paste: ReturnType<typeof vi.fn>
    input: ReturnType<typeof vi.fn>
  }
}

const PASTE_TEXT = 'ORCA_PASTE_TARGET_TEXT'

function createFakePane(id: number, leafId: string): FakePane {
  const container = document.createElement('div')
  const element = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  element.appendChild(textarea)
  container.appendChild(element)
  document.body.appendChild(container)
  return {
    id,
    leafId,
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

describe('createTerminalPanePasteExecution keyboard-owned paste targeting', () => {
  let paneA: FakePane
  let paneB: FakePane
  let setTerminalError: ReturnType<typeof vi.fn>

  beforeEach(() => {
    paneA = createFakePane(1, 'leaf-a')
    paneB = createFakePane(2, 'leaf-b')
    setTerminalError = vi.fn()
  })

  afterEach(() => {
    paneA.container.remove()
    paneB.container.remove()
  })

  function createExecution(
    activePane: FakePane
  ): ReturnType<typeof createTerminalPanePasteExecution> {
    const transports = new Map(
      [paneA, paneB].map((pane) => [
        pane.id,
        { getPtyId: () => `pty-${pane.id}`, isConnected: () => true }
      ])
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub supplies exactly the controller fields createTerminalPanePasteExecution destructures.
    const controller = {
      cwd: '/tmp',
      forceBracketedMultilineTextPaste: false,
      managerRef: { current: { getPanes: () => [paneA, paneB], getActivePane: () => activePane } },
      paneTransportsRef: { current: transports },
      setTerminalError,
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    } as unknown as TerminalPaneCloseController
    return createTerminalPanePasteExecution(controller, 'darwin')
  }

  it('aims an app-menu paste at the pane owning dispatch focus, not a stale active pane (#41352)', async () => {
    paneB.textarea.focus()
    const execution = createExecution(paneA)
    await execution.executePanePasteText(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake pane supplies the id/leafId/container/terminal subset this path reads.
      paneA as unknown as ManagedPane,
      'app-menu',
      paneB.textarea,
      PASTE_TEXT
    )
    expect(paneB.terminal.paste).toHaveBeenCalledWith(PASTE_TEXT)
    expect(paneA.terminal.paste).not.toHaveBeenCalled()
    expect(setTerminalError).not.toHaveBeenCalled()
  })

  it('still pastes into the requested pane when dispatch focus is that active pane', async () => {
    paneA.textarea.focus()
    const execution = createExecution(paneA)
    await execution.executePanePasteText(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake pane supplies the id/leafId/container/terminal subset this path reads.
      paneA as unknown as ManagedPane,
      'keyboard',
      paneA.textarea,
      PASTE_TEXT
    )
    expect(paneA.terminal.paste).toHaveBeenCalledWith(PASTE_TEXT)
    expect(paneB.terminal.paste).not.toHaveBeenCalled()
    expect(setTerminalError).not.toHaveBeenCalled()
  })
})
