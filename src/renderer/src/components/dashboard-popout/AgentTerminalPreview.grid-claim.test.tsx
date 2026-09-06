// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PreviewTerminal = {
  writeCallbacks: (() => void)[]
  write: ReturnType<typeof vi.fn>
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

const SURFACE = expect.any(String)

function snapshot(data: string, cols: number, rows: number, source?: 'headless') {
  return { snapshot: { source, data, cols, rows, seq: 1 }, replay: [] }
}

/** Give the mounted preview a measurable layout: an 80×24 grid at 10×16 cells inside a 900×480 box, so the claim asks for 90×30. */
async function mountMeasurable(): Promise<{ host: HTMLElement; terminal: PreviewTerminal }> {
  const view = render(<AgentTerminalPreview ptyId="pty-1" />)
  await vi.waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
  const terminal = terminalHarness.instances[0]!
  const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
  const box = host.parentElement!
  Object.defineProperty(box, 'clientWidth', { configurable: true, value: 900 })
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: 480 })
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  Object.defineProperty(screen, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(screen, 'offsetHeight', { configurable: true, value: 384 })
  host.appendChild(screen)
  return { host, terminal }
}

describe('AgentTerminalPreview grid claim', () => {
  const fit = vi.fn(async (_ptyId: string, cols: number, rows: number, _surfaceId?: string) => ({
    cols,
    rows
  }))
  const connect = vi.fn()
  let emitData: ((payload: unknown) => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    // happy-dom has no rAF loop under fake timers; run callbacks as macrotasks.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    )
    terminalHarness.instances.length = 0
    emitData = null
    connect.mockReset()
    connect.mockResolvedValue(snapshot('', 80, 24))
    Object.assign(window, {
      api: {
        terminalPreview: {
          connect,
          fit,
          input: vi.fn(async () => true),
          ack: vi.fn(async () => {}),
          unsubscribe: vi.fn(async () => {}),
          onData: (listener: (payload: unknown) => void) => {
            emitData = listener
            return vi.fn()
          }
        },
        ui: {}
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const claimThenResync = async (terminal: PreviewTerminal): Promise<void> => {
    act(() => terminal.writeCallbacks.splice(0).forEach((cb) => cb()))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30, SURFACE)
    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
  }

  it('re-requests a resync snapshot that does not carry the granted grid', async () => {
    fit.mockResolvedValue({ cols: 90, rows: 30 })
    connect
      .mockResolvedValueOnce(snapshot('a', 80, 24))
      // The resync after the claim: main's emulator was still seeding, so a
      // fallback answered with the parked pane's 80x24.
      .mockResolvedValueOnce(snapshot('b', 80, 24))
      .mockResolvedValueOnce(snapshot('c', 90, 30))
    const { host, terminal } = await mountMeasurable()

    await claimThenResync(terminal)
    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
    })
    expect(host.dataset.snapshotGrid).toBe('80x24')

    // Bounded retry, not a loop: one more ask lands the granted grid.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3))
    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(host.dataset.snapshotGrid).toBe('90x30')
    expect(connect).toHaveBeenCalledTimes(3)
  })

  it('adopts a headless snapshot at another grid instead of re-asking for the granted one', async () => {
    fit.mockResolvedValue({ cols: 90, rows: 30 })
    connect
      .mockResolvedValueOnce(snapshot('a', 80, 24))
      // Main's emulator tracks the PTY grid: another viewer took it to 120x40.
      .mockResolvedValueOnce(snapshot('b', 120, 40, 'headless'))
    const { host, terminal } = await mountMeasurable()

    await claimThenResync(terminal)
    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(host.dataset.snapshotGrid).toBe('120x40')
    expect(host.dataset.claimApplied).toBe('120x40')
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('adopts a stale-looking grid that survives the re-ask rather than retrying forever', async () => {
    fit.mockResolvedValue({ cols: 90, rows: 30 })
    connect.mockResolvedValueOnce(snapshot('a', 80, 24)).mockResolvedValue(snapshot('b', 80, 24))
    const { host, terminal } = await mountMeasurable()

    await claimThenResync(terminal)
    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(350)
    })
    // One re-ask; the same answer means the PTY really is at 80x24.
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3))
    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(connect).toHaveBeenCalledTimes(3)
    expect(host.dataset.claimApplied).toBe('80x24')
  })

  it('claims a grid sized to the dialog box and never re-requests an unchanged target', async () => {
    await mountMeasurable()

    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30, SURFACE)

    // A reconnect (e.g. the host reclaiming the grid) computes the same
    // target — no repeat claim, so no resize tug-of-war with the host.
    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(400)
    expect(fit).toHaveBeenCalledTimes(1)
  })
})
