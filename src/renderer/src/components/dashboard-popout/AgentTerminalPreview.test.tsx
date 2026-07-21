// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const terminalHarness = vi.hoisted(() => ({
  instances: [] as {
    write: ReturnType<typeof vi.fn>
    writeCallbacks: (() => void)[]
    onDataListener: ((data: string) => void) | null
    dispose: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
  }[],
  userInputListener: null as (() => void) | null,
  userInputDispose: vi.fn()
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24
    buffer = { active: { cursorY: 0 } }
    writeCallbacks: (() => void)[] = []
    onDataListener: ((data: string) => void) | null = null
    write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        this.writeCallbacks.push(callback)
      }
    })
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    onData = vi.fn((listener: (data: string) => void) => {
      this.onDataListener = listener
      return { dispose: vi.fn() }
    })

    constructor() {
      terminalHarness.instances.push(this)
    }
  }
}))
vi.mock('@/lib/pane-manager/pane-terminal-options', () => ({
  buildDefaultTerminalOptions: () => ({})
}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: (_terminal: unknown, listener: () => void) => {
    terminalHarness.userInputListener = listener
    return { dispose: terminalHarness.userInputDispose }
  }
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: null }) => unknown) => selector({ settings: null })
}))

import { AgentTerminalPreview } from './AgentTerminalPreview'

describe('AgentTerminalPreview', () => {
  const input = vi.fn(async () => true)
  const ack = vi.fn(async () => {})
  const unsubscribe = vi.fn(async () => {})
  const connect = vi.fn()
  let emitData: ((payload: unknown) => void) | null

  beforeEach(() => {
    terminalHarness.instances.length = 0
    terminalHarness.userInputListener = null
    emitData = null
    connect.mockResolvedValue({
      snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    Object.assign(window, {
      api: {
        terminalPreview: {
          connect,
          input,
          ack,
          unsubscribe,
          onData: (listener: (payload: unknown) => void) => {
            emitData = listener
            return vi.fn()
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('routes signaled user input while a live write parses and drops parser replies', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.onDataListener).not.toBeNull())

    act(() => {
      emitData?.({ type: 'data', ptyId: 'pty-1', data: '\x1b[6n', bytes: 4 })
    })
    expect(terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))

    act(() => {
      terminalHarness.userInputListener?.()
      terminal.onDataListener?.('k')
      terminal.onDataListener?.('\x1b[1;1R')
    })
    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenCalledWith('pty-1', 'k')

    act(() => terminal.writeCallbacks.shift()?.())
    expect(ack).toHaveBeenCalledWith('pty-1', 4)
  })

  it('keeps the existing terminal visible while a resync snapshot is captured', async () => {
    let resolveRefresh!: (value: {
      snapshot: { data: string; cols: number; rows: number; seq: number }
      replay: string[]
    }) => void
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          })
      )
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!

    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    expect(terminalHarness.instances).toHaveLength(1)
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(terminal.reset).not.toHaveBeenCalled()
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()

    await act(async () => {
      resolveRefresh({
        snapshot: { data: 'second', cols: 100, rows: 30, seq: 2 },
        replay: []
      })
    })
    await waitFor(() => expect(terminal.reset).toHaveBeenCalledTimes(1))
    expect(terminal.resize).toHaveBeenCalledWith(100, 30)
    expect(terminalHarness.instances).toHaveLength(1)
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()
  })

  it('disposes a stale terminal when resync confirms the pty is gone', async () => {
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockResolvedValueOnce({ snapshot: null, replay: [] })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!

    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))

    await waitFor(() => expect(view.getByText(/No live terminal/)).toBeInTheDocument())
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(terminalHarness.userInputDispose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledWith('pty-1')
  })

  it('connects a replacement pty after the previous pty was gone', async () => {
    connect.mockResolvedValueOnce({ snapshot: null, replay: [] }).mockResolvedValueOnce({
      snapshot: { data: 'replacement', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    const view = render(<AgentTerminalPreview ptyId="pty-gone" />)
    await waitFor(() => expect(view.getByText(/No live terminal/)).toBeInTheDocument())

    view.rerender(<AgentTerminalPreview ptyId="pty-live" />)

    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    expect(connect).toHaveBeenLastCalledWith('pty-live', { scrollbackRows: 24 })
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()
  })

  it('delays repeated capture after an overflow and cancels the retry on unmount', async () => {
    vi.useFakeTimers()
    connect.mockResolvedValue({
      snapshot: { data: 'screen', cols: 80, rows: 24, seq: 1 },
      replay: [],
      resyncRequired: true
    })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await vi.waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    expect(connect).toHaveBeenCalledTimes(1)

    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    await vi.advanceTimersByTimeAsync(149)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(connect).toHaveBeenCalledTimes(2)

    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    view.unmount()
    await vi.advanceTimersByTimeAsync(150)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
