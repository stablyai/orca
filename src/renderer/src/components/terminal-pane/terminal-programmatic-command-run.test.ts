import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import { handleTerminalProgrammaticCommandRun } from './terminal-programmatic-command-run'

type TestPane = {
  id: number
  leafId: string
  terminal: { focus: ReturnType<typeof vi.fn> }
}

function makePane(overrides: Partial<TestPane> = {}): TestPane {
  return {
    id: 1,
    leafId: 'leaf-1',
    terminal: { focus: vi.fn() },
    ...overrides
  }
}

function makeManager(activePane: TestPane | null, panes: TestPane[]) {
  return {
    getActivePane: vi.fn(() => activePane),
    getPanes: vi.fn(() => panes)
  }
}

function makeTransport(sent = true, ptyId = 'pty-1') {
  return {
    sendInput: vi.fn<(data: string) => boolean>(() => sent),
    getPtyId: vi.fn<() => string>(() => ptyId)
  }
}

describe('handleTerminalProgrammaticCommandRun', () => {
  beforeEach(() => {
    mocks.recordTerminalUserInputForLeaf.mockReset()
  })

  it('writes raw input to the active pane transport and focuses it', () => {
    const pane = makePane()
    const transport = makeTransport()

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'tab-1', input: 'npm run dev\r' },
      tabId: 'tab-1',
      getManager: () => makeManager(pane, [pane]) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never
    })

    expect(transport.sendInput).toHaveBeenCalledWith('npm run dev\r')
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('ignores events addressed to a different tab', () => {
    const pane = makePane()
    const transport = makeTransport()

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'other-tab', input: 'npm run dev\r' },
      tabId: 'tab-1',
      getManager: () => makeManager(pane, [pane]) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never
    })

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('does nothing when the active pane has no transport', () => {
    const pane = makePane()

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'tab-1', input: 'npm run dev\r' },
      tabId: 'tab-1',
      getManager: () => makeManager(pane, [pane]) as never,
      getPaneTransports: () => new Map() as never
    })

    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('does not record input when the transport rejects the write', () => {
    const pane = makePane()
    const transport = makeTransport(false)

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'tab-1', input: 'npm run dev\r' },
      tabId: 'tab-1',
      getManager: () => makeManager(pane, [pane]) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never
    })

    expect(transport.sendInput).toHaveBeenCalledWith('npm run dev\r')
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('falls back to the first pane when there is no active pane', () => {
    const pane = makePane()
    const transport = makeTransport()

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'tab-1', input: 'ls\r' },
      tabId: 'tab-1',
      getManager: () => makeManager(null, [pane]) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never
    })

    expect(transport.sendInput).toHaveBeenCalledWith('ls\r')
  })

  it('targets the pane that owns the probed ptyId, not the active pane', () => {
    const activePane = makePane({ id: 1, leafId: 'leaf-active' })
    const targetPane = makePane({ id: 2, leafId: 'leaf-target' })
    const activeTransport = makeTransport(true, 'pty-active')
    const targetTransport = makeTransport(true, 'pty-target')

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'tab-1', input: 'npm run dev\r', ptyId: 'pty-target' },
      tabId: 'tab-1',
      getManager: () => makeManager(activePane, [activePane, targetPane]) as never,
      getPaneTransports: () =>
        new Map([
          [activePane.id, activeTransport],
          [targetPane.id, targetTransport]
        ]) as never
    })

    expect(targetTransport.sendInput).toHaveBeenCalledWith('npm run dev\r')
    expect(activeTransport.sendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-target')
    expect(targetPane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('does nothing when no pane transport owns the probed ptyId', () => {
    const pane = makePane()
    const transport = makeTransport(true, 'pty-other')

    handleTerminalProgrammaticCommandRun({
      detail: { tabId: 'tab-1', input: 'npm run dev\r', ptyId: 'pty-missing' },
      tabId: 'tab-1',
      getManager: () => makeManager(pane, [pane]) as never,
      getPaneTransports: () => new Map([[pane.id, transport]]) as never
    })

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })
})
