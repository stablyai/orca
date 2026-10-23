// @vitest-environment happy-dom
/**
 * Runs against the real xterm package rather than a stub, because
 * the contract under test is xterm's: a non-zero smoothScrollDuration turns
 * public scrollToLine/scrollLines asynchronous, and only wheel deltas xterm
 * classifies as a physical mouse wheel are animated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { getTerminalScrollIntentKind } from './terminal-scroll-intent'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import { dispatchTerminalShortcutAction } from '../../components/terminal-pane/terminal-keyboard-action-dispatch'
import type { PaneManager } from './pane-manager'
import { captureScrollState, restoreScrollState } from './pane-scroll'
import { forceTerminalViewportScrollbarSync } from './terminal-viewport-scrollbar-sync'
import {
  attachTerminalWheelSmoothScroll,
  isMouseWheelNotch,
  resolveTerminalWheelScrollAnimationMs,
  TERMINAL_SMOOTH_SCROLL_DURATION_MS
} from './terminal-wheel-smooth-scroll'

// Pixel deltas: 40px is one physical notch to xterm; 7px reads as a trackpad.
const WHEEL_NOTCH_UP = -40
const TRACKPAD_UP = -7

let frames: FrameRequestCallback[]
let clock: number
const terminals: Terminal[] = []
let attachment: IDisposable | undefined

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

async function createScrolledTerminal(
  smoothScrolling: () => boolean,
  scrollback = 1000
): Promise<Terminal> {
  const container = document.createElement('div')
  document.body.append(container)
  const terminal = new Terminal({ cols: 40, rows: 10, scrollback, allowProposedApi: true })
  terminals.push(terminal)
  terminal.open(container)
  for (let i = 0; i < 100; i += 1) {
    await write(terminal, `line${i}\r\n`)
  }
  // Why: xterm's wheel classifier is a module singleton that scores a notch against the last five
  // wheel events, so earlier tests' events could decide whether this test's notch animates.
  for (let i = 0; i < 5; i += 1) {
    wheel(terminal, WHEEL_NOTCH_UP)
    terminal.scrollToBottom()
  }
  attachment = attachTerminalWheelSmoothScroll(terminal, smoothScrolling)
  // Why: the output above must not count as streaming, and its render frames belong to the past.
  clock += 10_000
  runFrames()
  return terminal
}

/** A wheel event shaped like Chromium's: wheelDeltaY is -3 x deltaY. */
function wheelEventFor(deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY })
  Object.defineProperty(event, 'wheelDeltaY', { value: -deltaY * 3 })
  return event
}

/** Counts writes to smoothScrollDuration, each of which fires xterm's option-change event. */
function countDurationWrites(terminal: Terminal): () => number {
  const descriptor = Object.getOwnPropertyDescriptor(terminal.options, 'smoothScrollDuration')
  let writes = 0
  Object.defineProperty(terminal.options, 'smoothScrollDuration', {
    configurable: true,
    enumerable: true,
    get: () => descriptor?.get?.call(terminal.options),
    set: (value: number) => {
      writes += 1
      descriptor?.set?.call(terminal.options, value)
    }
  })
  return () => writes
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function wheel(terminal: Terminal, deltaY: number, init: WheelEventInit = {}): void {
  const screen = terminal.element?.querySelector('.xterm-screen')
  if (!screen) {
    throw new Error('xterm screen element missing')
  }
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init })
  // Chromium reports wheelDeltaY as -3 x deltaY: a 40px notch is 120, a 7px trackpad delta 21.
  Object.defineProperty(event, 'wheelDeltaY', { value: -deltaY * 3 })
  screen.dispatchEvent(event)
}

function runFrames(): void {
  while (frames.length > 0) {
    frames.shift()?.(clock)
  }
}

/** Runs only the frames already queued, so a still-running animation cannot loop forever. */
function runQueuedFrames(): void {
  for (const frame of frames.splice(0)) {
    frame(clock)
  }
}

function finishAnimation(): void {
  clock += TERMINAL_SMOOTH_SCROLL_DURATION_MS + 50
  runFrames()
}

beforeEach(() => {
  frames = []
  clock = 1_000_000
  // happy-dom has no canvas text metrics; xterm measures glyphs on open().
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's DOM renderer only calls measureText on this context.
    {
      measureText: () => ({ width: 10, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 })
    } as unknown as CanvasRenderingContext2D
  )
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  // Why: xterm's frame scheduler is module state and stops requesting frames while one is pending,
  // so a frame dropped here, or an animation left unfinished, would stall every later test.
  clock += 10_000
  runFrames()
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('terminal wheel smooth scrolling', () => {
  it('animates a mouse-wheel notch through scrollback instead of jumping', async () => {
    const terminal = await createScrolledTerminal(() => true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bottom = terminal.buffer.active.baseY

    wheel(terminal, WHEEL_NOTCH_UP)

    expect(terminal.buffer.active.viewportY).toBe(bottom)
    expect(frames.length).toBeGreaterThan(0)
    // The duration is reset right after the event; the started animation must still land.
    vi.advanceTimersByTime(0)
    expect(terminal.options.smoothScrollDuration).toBe(0)
    finishAnimation()
    expect(terminal.buffer.active.viewportY).toBe(bottom - 3)
  })

  it('jumps immediately when the setting is off', async () => {
    const terminal = await createScrolledTerminal(() => false)
    const bottom = terminal.buffer.active.baseY

    wheel(terminal, WHEEL_NOTCH_UP)

    expect(terminal.buffer.active.viewportY).toBe(bottom - 3)
    expect(terminal.options.smoothScrollDuration).toBe(0)
  })

  it('keeps programmatic scrolls synchronous while a wheel animation is still running', async () => {
    const terminal = await createScrolledTerminal(() => true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    wheel(terminal, WHEEL_NOTCH_UP)
    vi.advanceTimersByTime(0)
    clock += 50
    runQueuedFrames()
    // A restore landing mid-animation must take effect at once and not be overridden.
    terminal.scrollToLine(10)

    expect(terminal.buffer.active.viewportY).toBe(10)
    finishAnimation()
    expect(terminal.buffer.active.viewportY).toBe(10)
  })

  it('leaves trackpad-sized deltas immediate even when enabled', async () => {
    const terminal = await createScrolledTerminal(() => true)
    for (let i = 0; i < 3; i += 1) {
      wheel(terminal, TRACKPAD_UP)
    }
    finishAnimation()
    const before = terminal.buffer.active.viewportY

    for (let i = 0; i < 6; i += 1) {
      wheel(terminal, TRACKPAD_UP)
    }

    // 6 x 7px at xterm's 1.25px-per-pixel wheel scale is 52.5px, or three 16px rows.
    expect(terminal.buffer.active.viewportY).toBe(before - 3)
  })

  it('scrolls up from the bottom immediately while output is streaming', async () => {
    const terminal = await createScrolledTerminal(() => true)
    await write(terminal, 'streamed\r\n')
    const bottom = terminal.buffer.active.baseY

    wheel(terminal, WHEEL_NOTCH_UP)
    // An armed animation would be cancelled by this output and the notch lost.
    await write(terminal, 'more\r\n')

    expect(terminal.buffer.active.viewportY).toBe(bottom - 3)
    expect(terminal.buffer.active.baseY).toBe(bottom + 1)
  })

  it('scrolls down immediately while output is streaming so it can reach the moving bottom', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-2)
    await write(terminal, 'streamed\r\n')

    wheel(terminal, -WHEEL_NOTCH_UP)

    expect(terminal.options.smoothScrollDuration).toBe(0)
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  })

  it('scrolls up immediately while output trims a full scrollback', async () => {
    const terminal = await createScrolledTerminal(() => true, 20)
    terminal.scrollLines(-8)
    await write(terminal, 'streamed\r\n')
    const before = terminal.buffer.active.viewportY

    wheel(terminal, WHEEL_NOTCH_UP)
    // Each trimmed line shifts the viewport by one row, which cancels an animation.
    await write(terminal, 'more\r\n')
    finishAnimation()

    expect(terminal.buffer.active.viewportY).toBe(before - 4)
  })

  it('does not animate while a TUI owns the wheel through mouse reporting', async () => {
    const terminal = await createScrolledTerminal(() => true)
    await write(terminal, '\x1b[?1000h')
    clock += 10_000

    wheel(terminal, WHEEL_NOTCH_UP)

    expect(terminal.options.smoothScrollDuration).toBe(0)
  })

  it('tolerates the duration reset firing after the terminal is disposed', async () => {
    const terminal = await createScrolledTerminal(() => true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    wheel(terminal, WHEEL_NOTCH_UP)
    terminal.dispose()

    expect(() => vi.advanceTimersByTime(0)).not.toThrow()
  })

  it('finishes a downward notch at the real bottom when output arrives mid-animation', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-3)
    runFrames()
    const armedBottom = terminal.buffer.active.baseY

    wheel(terminal, -WHEEL_NOTCH_UP)
    await sleep(0)
    clock += 40
    runQueuedFrames()
    // xterm keeps the animation's target at the bottom the notch started with.
    await write(terminal, 'resumed\r\n')
    finishAnimation()
    expect(terminal.buffer.active.baseY).toBe(armedBottom + 1)
    expect(terminal.buffer.active.viewportY).toBe(armedBottom)
    await sleep(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 40)

    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
    // Following output again is what a notch to the bottom promises.
    await write(terminal, 'more1\r\nmore2\r\nmore3\r\n')
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  })

  it('does not save a pin when a downward notch is finished at the bottom', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-3)
    runFrames()
    const host = terminal.element
    if (!host) {
      throw new Error('terminal element missing')
    }
    const tracking = attachTerminalScrollIntentTracking(terminal, host, undefined, {
      wheelScrollAnimationMs: (event) => resolveTerminalWheelScrollAnimationMs(true, event)
    })

    wheel(terminal, -WHEEL_NOTCH_UP)
    await sleep(0)
    clock += 40
    runQueuedFrames()
    await write(terminal, 'resumed\r\n')
    finishAnimation()
    // Wait past the scroll-intent settle (80 ms plus the animation).
    await sleep(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 120)
    tracking.dispose()

    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('scrolls a downward notch to the bottom immediately when a full scrollback would cancel it', async () => {
    const terminal = await createScrolledTerminal(() => true, 20)
    terminal.scrollLines(-3)
    runFrames()

    wheel(terminal, -WHEEL_NOTCH_UP)
    // Output resuming mid-animation trims lines and cancels an armed animation short of the bottom.
    await write(terminal, 'resumed\r\n')
    await sleep(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 40)

    expect(terminal.options.smoothScrollDuration).toBe(0)
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  })

  it('leaves a downward notch alone when it did not reach the bottom it started with', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-30)
    runFrames()

    wheel(terminal, -WHEEL_NOTCH_UP)
    await sleep(0)
    finishAnimation()
    const resting = terminal.buffer.active.viewportY
    await sleep(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 40)

    expect(resting).toBeLessThan(terminal.buffer.active.baseY)
    expect(terminal.buffer.active.viewportY).toBe(resting)
  })

  it('runs a scroll restore inside the reset window synchronously', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollToLine(40)
    const state = captureScrollState(terminal)
    terminal.scrollLines(20)
    runFrames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // A restore queued in an earlier frame runs after the wheel task but before its reset timer.
    frames.push(() => restoreScrollState(terminal, state))
    wheel(terminal, WHEEL_NOTCH_UP)
    runQueuedFrames()
    expect(terminal.buffer.active.viewportY).toBe(40)
    vi.advanceTimersByTime(0)
    finishAnimation()

    expect(terminal.buffer.active.viewportY).toBe(40)
  })

  it('keeps the scrollbar-sync jiggle synchronous inside the reset window', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollToLine(40)
    runFrames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    wheel(terminal, WHEEL_NOTCH_UP)
    // Replace the animated notch with a synchronous position, then jiggle at once.
    terminal.options.smoothScrollDuration = 125
    forceTerminalViewportScrollbarSync(terminal)

    expect(terminal.options.smoothScrollDuration).toBe(0)
    finishAnimation()
    expect(terminal.buffer.active.viewportY).toBe(40)
  })

  it('removes its listeners on dispose', async () => {
    const terminal = await createScrolledTerminal(() => true)
    attachment?.dispose()

    wheel(terminal, WHEEL_NOTCH_UP)

    expect(terminal.options.smoothScrollDuration).toBe(0)
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY - 3)
  })

  it('reports the settle time scroll intent must wait for', () => {
    const notch = wheelEventFor(-WHEEL_NOTCH_UP)
    const trackpad = wheelEventFor(-TRACKPAD_UP)
    expect(resolveTerminalWheelScrollAnimationMs(true, notch)).toBe(
      TERMINAL_SMOOTH_SCROLL_DURATION_MS
    )
    expect(resolveTerminalWheelScrollAnimationMs(true, trackpad)).toBe(0)
    expect(resolveTerminalWheelScrollAnimationMs(false, notch)).toBe(0)
    expect(resolveTerminalWheelScrollAnimationMs(undefined, notch)).toBe(0)
  })

  it('treats line-mode deltas and 120-step wheelDeltaY as a mouse wheel, nothing else', () => {
    expect(isMouseWheelNotch(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }))).toBe(true)
    expect(isMouseWheelNotch(wheelEventFor(40))).toBe(true)
    expect(isMouseWheelNotch(wheelEventFor(7))).toBe(false)
    expect(isMouseWheelNotch(new WheelEvent('wheel', { deltaY: 40 }))).toBe(false)
  })

  it('writes no option for trackpad-sized deltas', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-10)
    runFrames()
    const writes = countDurationWrites(terminal)

    for (let i = 0; i < 10; i += 1) {
      wheel(terminal, TRACKPAD_UP)
    }
    await sleep(0)

    expect(writes()).toBe(0)
  })

  it('writes the option twice for one animated notch', async () => {
    const terminal = await createScrolledTerminal(() => true)
    const writes = countDurationWrites(terminal)

    wheel(terminal, WHEEL_NOTCH_UP)
    await sleep(0)

    expect(writes()).toBe(2)
  })

  it('never animates a downward notch while the scrollback is full, however far it reaches', async () => {
    const terminal = await createScrolledTerminal(() => true, 20)
    terminal.options.scrollSensitivity = 5
    terminal.scrollLines(-12)
    runFrames()
    const writes = countDurationWrites(terminal)

    wheel(terminal, -WHEEL_NOTCH_UP, { altKey: true })
    await write(terminal, 'resumed\r\n')
    await sleep(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 40)

    expect(writes()).toBe(0)
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  })

  it('does not pull the viewport back to the bottom after the user wheels up', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-3)
    runFrames()
    const armedBottom = terminal.buffer.active.baseY

    wheel(terminal, -WHEEL_NOTCH_UP)
    await sleep(0)
    clock += 40
    runQueuedFrames()
    await write(terminal, 'resumed\r\n')
    finishAnimation()
    // The notch ended at the old bottom; the user scrolls up before the finish check runs.
    expect(terminal.buffer.active.viewportY).toBe(armedBottom)
    wheel(terminal, WHEEL_NOTCH_UP)
    await sleep(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 40)

    expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY)
  })

  it('runs the keyboard scroll-to-bottom action synchronously inside the reset window', async () => {
    const terminal = await createScrolledTerminal(() => true)
    terminal.scrollLines(-30)
    runFrames()
    const pane = { terminal }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scrollViewport action reads only the active pane.
    const manager = { getActivePane: () => pane, getPanes: () => [pane] } as unknown as PaneManager

    // A wheel notch armed the duration; a key press is its own task and can run before the reset timer.
    terminal.options.smoothScrollDuration = TERMINAL_SMOOTH_SCROLL_DURATION_MS
    dispatchTerminalShortcutAction(
      { type: 'scrollViewport', position: 'bottom' },
      new KeyboardEvent('keydown'),
      manager,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scrollViewport action never reads the other context members.
      {} as Parameters<typeof dispatchTerminalShortcutAction>[3]
    )

    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  })
})
