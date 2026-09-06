// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PreviewTerminal = {
  writeCallbacks: (() => void)[]
  write: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const terminalHarness = vi.hoisted(() => ({ instances: [] as PreviewTerminal[] }))
const storeState = vi.hoisted(() => ({
  settings: null,
  keybindings: {} as Record<string, string[]>
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 0, viewportY: 0, baseY: 0 } }
    writeCallbacks: (() => void)[] = []
    element = document.createElement('div')
    modes = { bracketedPasteMode: false, mouseTrackingMode: 'none' }
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
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
    paste = vi.fn()
    input = vi.fn()
    loadAddon = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    scrollToTop = vi.fn()
    scrollToBottom = vi.fn()
    selectAll = vi.fn()
    getSelection = vi.fn(() => '')
    attachCustomKeyEventHandler = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))

    constructor() {
      terminalHarness.instances.push(this)
    }
  }
}))
vi.mock(import('@/lib/pane-manager/pane-terminal-options'), async (importOriginal) => ({
  ...(await importOriginal()),
  buildDefaultTerminalOptions: () => ({})
}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: () => ({ dispose: vi.fn() })
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))
vi.mock('@/components/terminal-pane/terminal-ime-native-text-forwarder', () => ({
  installTerminalImeNativeTextForwarder: () => ({ claimKeyEvent: () => false, dispose: vi.fn() })
}))
vi.mock('@/components/terminal-pane/terminal-ime-composition-tracker', () => ({
  installTerminalImeCompositionTracker: () => ({ isActive: () => false, dispose: vi.fn() })
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof storeState) => unknown): unknown =>
    selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

import { AgentTerminalPreview } from './AgentTerminalPreview'

/** A snapshot that is missing is not a verdict: the preview keeps its frame and asks again. */
describe('AgentTerminalPreview snapshot liveness', () => {
  const connect = vi.fn()
  const dataListeners: ((payload: unknown) => void)[] = []
  const emitData = (payload: unknown): void => dataListeners.forEach((l) => l(payload))

  beforeEach(() => {
    vi.useFakeTimers()
    terminalHarness.instances.length = 0
    dataListeners.length = 0
    connect.mockReset()
    Object.assign(window, {
      api: {
        terminalPreview: {
          connect,
          fit: vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows })),
          input: vi.fn(async () => true),
          ack: vi.fn(async () => {}),
          unsubscribe: vi.fn(async () => {}),
          onData: (listener: (payload: unknown) => void) => {
            dataListeners.push(listener)
            return () => dataListeners.splice(dataListeners.indexOf(listener), 1)
          }
        },
        ui: {}
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('shows starting during the initial snapshot grace period', async () => {
    vi.useFakeTimers()
    connect
      .mockResolvedValueOnce({ snapshot: null, replay: [], liveness: 'unverifiable' })
      .mockResolvedValue({
        snapshot: { data: 'first frame', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
    const view = render(<AgentTerminalPreview ptyId="new-pty" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(view.getByText('Starting session…')).toBeInTheDocument()
    expect(view.queryByText('Preview unavailable. Retrying…')).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(terminalHarness.instances[0]?.write).toHaveBeenCalled()
    expect(view.queryByText('Preview unavailable. Retrying…')).not.toBeInTheDocument()
  })

  it('keeps its frame and retries a transient null snapshot without reporting exit', async () => {
    vi.useFakeTimers()
    const onPtyGone = vi.fn()
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockResolvedValueOnce({ snapshot: null, replay: [], liveness: 'unverifiable' })
      .mockResolvedValue({
        snapshot: { data: 'reconnected', cols: 80, rows: 24, seq: 2 },
        replay: []
      })
    const view = render(<AgentTerminalPreview ptyId="pty-1" onPtyGone={onPtyGone} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    const terminal = terminalHarness.instances[0]!
    await act(async () => {
      emitData({ type: 'resync', ptyId: 'pty-1' })
    })
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(onPtyGone).not.toHaveBeenCalled()
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(connect).toHaveBeenCalledTimes(3)
    expect(terminalHarness.instances).toHaveLength(1)
    expect(terminal.reset).toHaveBeenCalledTimes(1)
    expect(onPtyGone).not.toHaveBeenCalled()
  })

  it.each(['legacy', 'rejected'] as const)(
    'retries %s snapshot failures with bounded polling and cleans up on unmount',
    async (failure) => {
      vi.useFakeTimers()
      if (failure === 'legacy') {
        connect.mockResolvedValue({ snapshot: null, replay: [] })
      } else {
        connect.mockRejectedValue(new Error('host unavailable'))
      }
      const onPtyGone = vi.fn()
      const view = render(<AgentTerminalPreview ptyId="pty-1" onPtyGone={onPtyGone} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(onPtyGone).not.toHaveBeenCalled()
      expect(view.getByText('Preview unavailable. Retrying…')).toBeInTheDocument()
      expect(connect.mock.calls.length).toBeGreaterThan(2)
      expect(connect.mock.calls.length).toBeLessThan(15)
      view.unmount()
      const calls = connect.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(connect).toHaveBeenCalledTimes(calls)
    }
  )
})
