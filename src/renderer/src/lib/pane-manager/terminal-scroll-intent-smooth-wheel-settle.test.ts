import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTerminalScrollIntentKind } from './terminal-scroll-intent'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'

function createTerminal(viewportY: number, baseY: number) {
  const terminal = {
    buffer: { active: { type: 'normal' as const, viewportY, baseY } },
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    })
  }
  return terminal
}

function wheel(host: EventTarget, deltaY: number): void {
  const event = new Event('wheel')
  Object.defineProperty(event, 'deltaY', { value: deltaY })
  host.dispatchEvent(event)
}

/** Wheels toward the bottom while an animation is still mid-flight at the 80ms settle tick. */
async function wheelDownWithLateAnimation(wheelScrollAnimationMs: number) {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  const terminal = createTerminal(50, 100)
  const host = new EventTarget()
  const disposable = attachTerminalScrollIntentTracking(
    terminal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: wheel tracking only adds/removes listeners on the host.
    host as HTMLElement,
    undefined,
    { wheelScrollAnimationMs: () => wheelScrollAnimationMs }
  )
  wheel(host, 10)
  await Promise.resolve()
  terminal.buffer.active.viewportY = 90
  vi.advanceTimersByTime(80)
  terminal.buffer.active.viewportY = 100
  vi.advanceTimersByTime(1000)
  return { terminal, disposable }
}

describe('scroll intent after a smooth wheel animation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('latches the mid-animation row when the settle tick ignores the animation', async () => {
    const { terminal, disposable } = await wheelDownWithLateAnimation(0)

    // The viewport sits at the bottom, yet the recorded intent is a stale pin.
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    disposable.dispose()
  })

  it('reclassifies from where the animation lands, so reaching the bottom follows output', async () => {
    const { terminal, disposable } = await wheelDownWithLateAnimation(125)

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it("keeps a newer upward wheel pinned when an earlier wheel's settle fires first", async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 0)
    const terminal = createTerminal(100, 100)
    const host = new EventTarget()
    const disposable = attachTerminalScrollIntentTracking(
      terminal,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: wheel tracking only adds/removes listeners on the host.
      host as HTMLElement,
      undefined,
      { wheelScrollAnimationMs: () => 125 }
    )
    wheel(host, 10)
    await Promise.resolve()
    vi.advanceTimersByTime(200)
    // The upward animation has not moved the viewport when the first wheel settles at 205ms.
    wheel(host, -10)
    await Promise.resolve()
    vi.advanceTimersByTime(5)

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    terminal.buffer.active.viewportY = 97
    vi.advanceTimersByTime(1000)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    disposable.dispose()
  })
})
