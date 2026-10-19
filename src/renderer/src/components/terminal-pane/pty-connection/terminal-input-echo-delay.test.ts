import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INPUT_ECHO_DELAY_MAX_ALLOWANCE_MS,
  createTerminalInputEchoDelay,
  noteTerminalInputAwaitingEcho,
  noteTerminalOutputAfterInput,
  terminalInputEchoAllowanceMs,
  type TerminalInputEchoDelay
} from './terminal-input-echo-delay'
import { bindForegroundOutputRefresh } from './foreground-output-refresh'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'
import { FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS } from './foreground-output-budgets'

const writeTerminalOutput = vi.hoisted(() => vi.fn())

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  writeTerminalOutput
}))

vi.mock('@/lib/pane-manager/terminal-render-pause-release', () => ({
  forceFullViewportPresent: vi.fn()
}))

vi.mock('@/lib/pane-manager/terminal-delivery-credit', () => ({
  takeCurrentTerminalDeliveryCredit: vi.fn(() => undefined)
}))

afterEach(() => {
  vi.restoreAllMocks()
  writeTerminalOutput.mockReset()
})

describe('terminal input echo delay', () => {
  it('measures the round trip from the oldest unanswered input', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalInputAwaitingEcho(delay, 1000)
    noteTerminalInputAwaitingEcho(delay, 1040)
    noteTerminalOutputAfterInput(delay, 1200)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(200)
  })

  it('stays at zero with no input, so output alone never widens the windows', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalOutputAfterInput(delay, 5000)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(0)
  })

  it('takes the recent minimum so one slow frame cannot inflate it', () => {
    const delay = createTerminalInputEchoDelay()
    for (const [input, output] of [
      [0, 210],
      [1000, 1900],
      [2000, 2205]
    ]) {
      noteTerminalInputAwaitingEcho(delay, input)
      noteTerminalOutputAfterInput(delay, output)
    }
    expect(terminalInputEchoAllowanceMs(delay)).toBe(205)
  })

  it('ignores output that cannot be the echo and clamps the allowance', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalInputAwaitingEcho(delay, 0)
    noteTerminalOutputAfterInput(delay, 5000)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(0)
    noteTerminalInputAwaitingEcho(delay, 6000)
    noteTerminalOutputAfterInput(delay, 6900)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(INPUT_ECHO_DELAY_MAX_ALLOWANCE_MS)
  })

  it('restarts a pending input that went unanswered past the sample limit', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalInputAwaitingEcho(delay, 0)
    noteTerminalInputAwaitingEcho(delay, 3000)
    noteTerminalOutputAfterInput(delay, 3180)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(180)
  })
})

function mockNow(now: { value: number }): void {
  vi.spyOn(performance, 'now').mockImplementation(() => now.value)
}

describe('remote echo keeps typing latency-sensitive', () => {
  const largeRedraw = `\x1b[H${'x'.repeat(FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS + 1)}`

  type RefreshSession = {
    [key: string]: unknown
    lastInteractiveRedrawInputAt: number
    inputEchoDelay: TerminalInputEchoDelay
    isLatencySensitiveForegroundOutput?: (data: string) => boolean
  }

  function createRefreshSession(): RefreshSession {
    const session: RefreshSession = {
      deps: { isActiveRef: { current: true } },
      manager: { getActivePane: () => null },
      foregroundImmediateBudget: { chars: 0, windowStart: 0 },
      lastInteractiveRedrawInputAt: Number.NEGATIVE_INFINITY,
      inputEchoDelay: createTerminalInputEchoDelay()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: isLatencySensitiveForegroundOutput reads only the fields above plus its own bindings.
    bindForegroundOutputRefresh(session as never)
    return session
  }

  it('classifies a 200ms-RTT redraw as interactive once the echo delay is known', () => {
    const now = { value: 10_000 }
    mockNow(now)
    const session = createRefreshSession()
    // Local calibration alone: the redraw lands 200ms after input, outside the 150ms window.
    session.lastInteractiveRedrawInputAt = now.value
    now.value += 200
    expect(session.isLatencySensitiveForegroundOutput?.(largeRedraw)).toBe(false)

    noteTerminalInputAwaitingEcho(session.inputEchoDelay, 11_000)
    noteTerminalOutputAfterInput(session.inputEchoDelay, 11_200)
    now.value = 12_000
    session.lastInteractiveRedrawInputAt = now.value
    now.value += 200
    expect(session.isLatencySensitiveForegroundOutput?.(largeRedraw)).toBe(true)
  })

  it('calibrates the synchronized-frame latch from the echo it is writing', () => {
    const now = { value: 50_000 }
    mockNow(now)
    const inputEchoDelay = createTerminalInputEchoDelay()
    const session: {
      [key: string]: unknown
      writePtyOutputToXterm?: (data: string, foreground: boolean) => void
    } = {
      kittyKeyboardModes: { scan: vi.fn() },
      resetHiddenOutputRestoreIfPtyChanged: vi.fn(),
      transport: { getPtyId: vi.fn(() => 'remote:pty-1') },
      canUseHiddenOutputSnapshot: vi.fn(() => false),
      shouldSnapshotHiddenCodexOutput: false,
      shouldProtectNativeWindowsSynchronizedOutput: true,
      shouldApplyNativeWindowsRewriteRefresh: false,
      synchronizedForegroundMarkerTail: '',
      synchronizedForegroundOutputActive: false,
      synchronizedForegroundFrameInteractive: false,
      synchronizedForegroundInteractivePresentPending: false,
      lastTerminalInputAt: now.value,
      inputEchoDelay,
      scheduleForegroundGridDriftCheck: vi.fn(),
      shouldForceForegroundRenderRefresh: vi.fn(() => ({ refresh: false, inPlaceRewrite: false })),
      isLatencySensitiveForegroundOutput: vi.fn(() => false),
      shouldRefreshForegroundSynchronously: false,
      markHiddenOutputRestoreNeeded: vi.fn(),
      pane: { terminal: {} }
    }
    noteTerminalInputAwaitingEcho(inputEchoDelay, now.value)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies exactly the fields read by this isolated binding test.
    bindWritePtyOutputToXterm(session as never)
    // A 450ms round trip: past the local 400ms latch, inside it once widened by the echo.
    now.value += 450
    session.writePtyOutputToXterm?.('\x1b[?2026hframe', true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scheduler mock receives the binding's documented options object.
    const options = writeTerminalOutput.mock.calls[0]?.[2] as { latencySensitive?: boolean }
    expect(options.latencySensitive).toBe(true)
  })
})
