import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'

const mocks = vi.hoisted(() => ({
  pasteTerminalText: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-bracketed-paste', () => ({
  BRACKETED_PASTE_END: '\u001b[201~',
  BRACKETED_PASTE_START: '\u001b[200~',
  pasteTerminalText: mocks.pasteTerminalText,
  sanitizeTerminalPasteText: (text: string) => text.split('\u001b').join('\u241b')
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

import { handleTerminalProgrammaticTextPaste } from './terminal-programmatic-text-paste'

type TestPane = {
  id: number
  leafId: string
  terminal: {
    focus: ReturnType<typeof vi.fn>
    modes: { bracketedPasteMode: boolean }
  }
}

function makePane(): TestPane {
  return {
    id: 1,
    leafId: 'leaf-1',
    terminal: {
      focus: vi.fn(),
      modes: { bracketedPasteMode: false }
    }
  }
}

function makeManager(pane: TestPane) {
  return {
    getActivePane: vi.fn(() => pane),
    getPanes: vi.fn(() => [pane])
  }
}

function makeManagerWithPanes(activePane: TestPane, panes: TestPane[]) {
  return {
    getActivePane: vi.fn(() => activePane),
    getPanes: vi.fn(() => panes)
  }
}

function makeTransport(options: { connected?: boolean } = {}) {
  return {
    getPtyId: vi.fn(() => 'pty-1'),
    isConnected: vi.fn(() => options.connected ?? true),
    sendInput: vi.fn<(data: string) => boolean>(() => true)
  }
}

async function flushPasteTasks(iterations = 6): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('terminal programmatic text paste', () => {
  it('does not direct-paste through xterm when the pane has no live transport', async () => {
    const pane = makePane()

    handleTerminalProgrammaticTextPaste({
      detail: { tabId: 'tab-1', text: 'secret-token-value' },
      getManager: () => makeManager(pane) as never,
      getPaneTransports: () => new Map(),
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    })
    await flushPasteTasks()

    expect(mocks.pasteTerminalText).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('rejects disconnected programmatic paste before writing terminal input', async () => {
    const pane = makePane()
    const transport = makeTransport({ connected: false })

    handleTerminalProgrammaticTextPaste({
      detail: { tabId: 'tab-1', text: 'git status' },
      getManager: () => makeManager(pane) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never,
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    })
    await flushPasteTasks()

    expect(mocks.pasteTerminalText).not.toHaveBeenCalled()
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('rejects programmatic paste when the pane transport changes before execution', async () => {
    const pane = makePane()
    const originalTransport = makeTransport()
    const replacementTransport = makeTransport()
    let transportLookupCount = 0

    handleTerminalProgrammaticTextPaste({
      detail: { tabId: 'tab-1', text: 'git status' },
      getManager: () => makeManager(pane) as never,
      getPaneTransports: () => {
        transportLookupCount += 1
        return new Map([
          [pane.id, transportLookupCount === 1 ? originalTransport : replacementTransport]
        ]) as never
      },
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    })
    await flushPasteTasks()

    expect(mocks.pasteTerminalText).not.toHaveBeenCalled()
    expect(originalTransport.sendInput).not.toHaveBeenCalled()
    expect(replacementTransport.sendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('chunks large programmatic paste through the live PTY transport', async () => {
    const pane = makePane()
    const transport = makeTransport()
    const largePaste = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`

    handleTerminalProgrammaticTextPaste({
      detail: { tabId: 'tab-1', text: largePaste },
      getManager: () => makeManager(pane) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never,
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    })
    await flushPasteTasks(12)

    expect(mocks.pasteTerminalText).not.toHaveBeenCalled()
    expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).toBe(largePaste)
    expect(transport.sendInput.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('uses the requested pane id instead of the active pane for targeted insertion', async () => {
    const activePane = makePane()
    const targetPane = {
      ...makePane(),
      id: 2,
      leafId: 'leaf-2'
    }
    const activeTransport = makeTransport()
    const targetTransport = makeTransport()

    handleTerminalProgrammaticTextPaste({
      detail: { paneId: targetPane.id, tabId: 'tab-1', text: 'dictated text' },
      getManager: () => makeManagerWithPanes(activePane, [activePane, targetPane]) as never,
      getPaneTransports: () =>
        new Map([
          [activePane.id, activeTransport],
          [targetPane.id, targetTransport]
        ]) as never,
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    })
    await flushPasteTasks()

    expect(mocks.pasteTerminalText).toHaveBeenCalledWith(targetPane.terminal, 'dictated text', {
      forceBracketedPaste: false
    })
    expect(activeTransport.sendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-2')
    expect(targetPane.terminal.focus).toHaveBeenCalledOnce()
  })
})
