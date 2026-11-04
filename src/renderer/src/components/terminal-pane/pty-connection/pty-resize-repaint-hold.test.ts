// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPtyResizeRepaintHold,
  PTY_RESIZE_ABSOLUTE_MAX_HOLD_MS,
  PTY_RESIZE_INITIAL_WAIT_MS,
  PTY_RESIZE_MAX_HOLD_MS,
  PTY_RESIZE_POST_PARSE_SETTLE_MS
} from './pty-resize-repaint-hold'

function createPaintedTerminal() {
  const root = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () =>
    ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, x: 0, y: 0 }) as DOMRect
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  screen.appendChild(canvas)
  root.appendChild(screen)
  document.body.appendChild(root)

  const scrollToBottom = vi.fn()
  const refresh = vi.fn()
  const terminal = {
    element: root,
    rows: 24,
    refresh,
    scrollToBottom,
    buffer: {
      active: {
        type: 'normal',
        viewportY: 120,
        baseY: 120
      }
    }
  }
  return { root, screen, terminal, scrollToBottom, refresh }
}

describe('createPtyResizeRepaintHold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('holds presentation across multi-chunk post-resize repaints and restores bottom anchor once settled', () => {
    const { root, screen, terminal, scrollToBottom } = createPaintedTerminal()
    const hold = createPtyResizeRepaintHold(terminal)

    hold.hold()
    expect(screen.style.opacity).toBe('0')
    expect(root.querySelector('[data-terminal-replay-frame="true"]')).not.toBeNull()

    // Chunk 1 arrives at 30ms (e.g. clear screen + top of agent conversation)
    vi.advanceTimersByTime(30)
    hold.noteOutputQueued()
    vi.advanceTimersByTime(40)
    expect(screen.style.opacity).toBe('0')
    hold.noteOutputParsed()

    // Chunk 2 arrives 20ms later (before 48ms post-parse settle expires)
    vi.advanceTimersByTime(20)
    hold.noteOutputQueued()
    vi.advanceTimersByTime(35)
    hold.noteOutputParsed()
    expect(screen.style.opacity).toBe('0')
    expect(scrollToBottom).not.toHaveBeenCalled()

    // Quiet settle completes -> unhide atomically at bottom
    vi.advanceTimersByTime(PTY_RESIZE_POST_PARSE_SETTLE_MS)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(screen.style.opacity).toBe('')
    expect(root.querySelector('[data-terminal-replay-frame="true"]')).toBeNull()
  })

  it('releases cleanly after initial wait when an idle shell emits zero bytes on SIGWINCH', () => {
    const { screen, terminal, scrollToBottom } = createPaintedTerminal()
    const hold = createPtyResizeRepaintHold(terminal)

    hold.hold()
    expect(screen.style.opacity).toBe('0')

    vi.advanceTimersByTime(PTY_RESIZE_INITIAL_WAIT_MS)
    expect(screen.style.opacity).toBe('')
    expect(scrollToBottom).not.toHaveBeenCalled()
  })

  it('releases immediately on user input or at the max hold ceiling during continuous output', () => {
    const { screen, terminal } = createPaintedTerminal()
    const hold = createPtyResizeRepaintHold(terminal)

    hold.hold()
    hold.noteOutputQueued()
    vi.advanceTimersByTime(PTY_RESIZE_MAX_HOLD_MS)
    expect(screen.style.opacity).toBe('')

    hold.hold()
    expect(screen.style.opacity).toBe('0')
    hold.releaseNow()
    expect(screen.style.opacity).toBe('')
  })

  it('extends the hold deadline up to the absolute ceiling while rewrite chunks stream continuously', () => {
    const { screen, terminal, scrollToBottom } = createPaintedTerminal()
    const hold = createPtyResizeRepaintHold(terminal)

    hold.hold()
    // Stream rewrite chunks every 30ms past the initial 380ms ceiling (e.g. 600ms full-history TUI redraw)
    for (let elapsed = 0; elapsed < 600; elapsed += 30) {
      vi.advanceTimersByTime(30)
      hold.noteOutputQueued()
      hold.noteOutputParsed()
      expect(screen.style.opacity).toBe('0')
    }

    vi.advanceTimersByTime(PTY_RESIZE_POST_PARSE_SETTLE_MS)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(screen.style.opacity).toBe('')

    // Never holds past PTY_RESIZE_ABSOLUTE_MAX_HOLD_MS even if chunks never stop
    hold.hold()
    for (let elapsed = 0; elapsed < PTY_RESIZE_ABSOLUTE_MAX_HOLD_MS; elapsed += 30) {
      hold.noteOutputQueued()
      vi.advanceTimersByTime(30)
      hold.noteOutputParsed()
    }
    expect(screen.style.opacity).toBe('')
  })
})
