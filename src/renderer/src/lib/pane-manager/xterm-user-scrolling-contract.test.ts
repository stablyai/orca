/** Pin native follow/pin ownership through shared headless/core BufferService. Live writes rely on xterm; app enforcement handles structural replay/remount/reflow only. Upgrades must preserve this contract. Since beta.302 (#6081), CSI 3 J releases native pins; Orca observes before erase to capture and restore the live reading offset. */
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { clearTerminalScrollbackAndFollowOutput } from './terminal-scrollback-clear'
import { installTerminalLiveScrollbackRestore } from './terminal-live-scrollback-restore'
import { markTerminalPinnedViewport } from './terminal-scroll-intent'

type TerminalWithBufferService = Terminal & {
  _core?: {
    _bufferService?: { isUserScrolling?: boolean }
    coreService?: { onUserInput?: (listener: () => void) => { dispose: () => void } }
  }
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function writeLines(term: Terminal, count: number, label: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await write(term, `${label}${i}\r\n`)
  }
}

/** 100 lines of scrollback with the viewport pinned 30 rows up and that pin recorded. */
async function pinnedScrollbackTerminal(): Promise<TerminalWithBufferService> {
  const term = new Terminal({
    rows: 10,
    cols: 40,
    scrollback: 1000,
    allowProposedApi: true
  }) as TerminalWithBufferService
  await write(term, Array.from({ length: 100 }, (_, index) => `before${index}\r\n`).join(''))
  term.scrollLines(-30)
  markTerminalPinnedViewport(term)
  return term
}

describe('xterm native user-scrolling contract', () => {
  it('resets native user-scrolling when a pinned scrollback is cleared', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    term.scrollLines(-5)
    expect(term._core?._bufferService?.isUserScrolling).toBe(true)

    clearTerminalScrollbackAndFollowOutput(term)
    expect(term.buffer.active.viewportY).toBe(0)
    expect(term.buffer.active.baseY).toBe(0)
    expect(term._core?._bufferService?.isUserScrolling).toBe(false)

    await writeLines(term, 15, 'after-clear')
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })
})

/** Give each virtual schedule its own cancellable timer so missing cancellation appears as an extra firing, not an absorbed debounce. */
function manualSettleScheduler(): {
  now: () => number
  scheduleSettle: (run: () => void, delayMs: number) => () => void
  advance: (ms: number) => void
  scheduleCount: () => number
  cancelCount: () => number
  liveTimerCount: () => number
} {
  type FakeTimer = { run: () => void; dueAt: number; dead: boolean }
  const timers: FakeTimer[] = []
  let nowMs = 0
  let scheduleCount = 0
  let cancelCount = 0
  return {
    now: () => nowMs,
    scheduleSettle: (run, delayMs) => {
      const timer: FakeTimer = { run, dueAt: nowMs + delayMs, dead: false }
      timers.push(timer)
      scheduleCount += 1
      return () => {
        if (!timer.dead) {
          cancelCount += 1
        }
        timer.dead = true
      }
    },
    advance: (ms) => {
      nowMs += ms
      // Bound loops so zero-delay rearm fails instead of hanging CI.
      for (let fired = 0; ; fired += 1) {
        if (fired > 1_000) {
          throw new Error('settle scheduler livelocked: zero-delay re-arm loop')
        }
        let due: FakeTimer | null = null
        for (const timer of timers) {
          if (!timer.dead && timer.dueAt <= nowMs && (!due || timer.dueAt < due.dueAt)) {
            due = timer
          }
        }
        if (!due) {
          return
        }
        due.dead = true
        due.run()
      }
    },
    scheduleCount: () => scheduleCount,
    cancelCount: () => cancelCount,
    liveTimerCount: () => timers.filter((timer) => !timer.dead).length
  }
}

const SETTLE_MS = 120

async function pinnedTerminalWithRestore(): Promise<{
  term: TerminalWithBufferService
  advance: (ms: number) => void
  settle: () => void
  bottomOffset: number
  restore: { dispose: () => void }
  scheduleCount: () => number
  cancelCount: () => number
}> {
  const term = await pinnedScrollbackTerminal()
  const scheduler = manualSettleScheduler()
  const restore = installTerminalLiveScrollbackRestore(term, {
    now: scheduler.now,
    scheduleSettle: scheduler.scheduleSettle
  })
  return {
    term,
    advance: scheduler.advance,
    settle: () => scheduler.advance(SETTLE_MS),
    bottomOffset: term.buffer.active.baseY - term.buffer.active.viewportY,
    restore,
    scheduleCount: scheduler.scheduleCount,
    cancelCount: scheduler.cancelCount
  }
}

describe('live scrollback-erase pin (CSI 3 J)', () => {
  it('restores a pinned viewport after a live full-screen scrollback clear', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[?2026h\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(50)}\x1b[?2026l`)
    // CSI 3 J releases native isUserScrolling; Orca must restore the previous reading offset after redraw.
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    settle()

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - bottomOffset)
    expect(term._core?._bufferService?.isUserScrolling).toBe(true)
  })

  it('ignores erase-in-display forms that keep the scrollback', async () => {
    const { term, settle, scheduleCount } = await pinnedTerminalWithRestore()
    const pinnedY = term.buffer.active.viewportY

    // Every one of these is a routine TUI repaint; none erases scrollback.
    for (const sequence of [
      '\x1b[J',
      '\x1b[0J',
      '\x1b[1J',
      '\x1b[2J',
      '\x1b[?0J',
      '\x1b[?1J',
      '\x1b[?2J'
    ]) {
      await write(term, sequence)
    }
    await writeLines(term, 200, 'after')
    expect(scheduleCount()).toBe(0)
    settle()

    expect(term.buffer.active.viewportY).toBe(pinnedY)
  })

  it('holds the pin while the redraw keeps arriving and lands it once quiet', async () => {
    const { term, advance, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(60)}`)
    for (let frame = 0; frame < 5; frame += 1) {
      advance(SETTLE_MS - 60)
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
      await write(term, 'after\r\n'.repeat(40))
    }
    advance(SETTLE_MS)

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('spends the pin once even when the rebuild stays shorter than the old scrollback', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    // A short rebuild skips intent relatching; only single-shot disarm prevents follow-at-offset.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(60)}`)
    settle()
    const restoredY = term.buffer.active.viewportY
    expect(restoredY).toBe(term.buffer.active.baseY - bottomOffset)

    await writeLines(term, 200, 'later')
    settle()
    expect(term.buffer.active.viewportY).toBe(restoredY)
  })

  it('measures the pin from the rows already written earlier in the same chunk', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()
    const rowsBeforeErase = 20

    // Capture at parser erase, not write boundary, to include rows preceding erase in the same chunk.
    await write(
      term,
      `${'pre\r\n'.repeat(rowsBeforeErase)}\x1b[2J\x1b[H\x1b[3J${'post\r\n'.repeat(120)}`
    )
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(
      bottomOffset + rowsBeforeErase
    )
  })

  it('keeps the original pin when a second erase lands inside the settle window', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    // The second erase sees native follow-output after the first; reuse the original pin rather than losing its prior coordinates.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'first\r\n'.repeat(160)}`)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    expect(term.buffer.active.baseY).toBeGreaterThan(0)

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'second\r\n'.repeat(160)}`)
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it("re-captures from the reader's new position when they move between two erases", async () => {
    const { term, advance, scheduleCount } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'first\r\n'.repeat(300)}`)
    expect(scheduleCount()).toBeGreaterThan(0)

    term.scrollLines(250)
    markTerminalPinnedViewport(term)
    const movedOffset = term.buffer.active.baseY - term.buffer.active.viewportY

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'second\r\n'.repeat(300)}`)
    advance(2_000)

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(movedOffset)
  })

  it('keeps one deadline across a repeating clear so the pin still lands', async () => {
    const { term, advance, bottomOffset } = await pinnedTerminalWithRestore()

    // Repeated clears restore only because the first deadline stays fixed; ten 100ms cycles reach the cap.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await write(term, `\x1b[2J\x1b[H\x1b[3J${'redraw\r\n'.repeat(140)}`)
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
      advance(100)
    }

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('does not spend the pin on a redraw that stalls half-built', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    // A delivery gap mid-redraw fires the settle while the rebuild is too short.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'partial\r\n'.repeat(5)}`)
    settle()
    expect(term.buffer.active.viewportY).toBe(0)

    await write(term, 'rest\r\n'.repeat(140))
    settle()
    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('gives up on a rebuild that never reaches the offset before the deadline', async () => {
    const { term, advance, bottomOffset, scheduleCount } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'partial\r\n'.repeat(20)}`)
    expect(term.buffer.active.baseY).toBeGreaterThan(0)
    expect(term.buffer.active.baseY).toBeLessThan(bottomOffset)

    advance(2_000)
    const schedulesAfterGiveUp = scheduleCount()
    expect(term.buffer.active.viewportY).toBe(0)

    await writeLines(term, 300, 'later')
    advance(2_000)
    expect(scheduleCount()).toBe(schedulesAfterGiveUp)
    expect(term.buffer.active.viewportY).toBe(0)
  })

  it('does not arm for a reader who is back at the bottom under a stale durable pin', async () => {
    const term = await pinnedScrollbackTerminal()
    const scheduler = manualSettleScheduler()
    installTerminalLiveScrollbackRestore(term, {
      now: scheduler.now,
      scheduleSettle: scheduler.scheduleSettle
    })

    // Durable pre-remount pins can describe old geometry even after the live reader returned to follow-output.
    term.clear()
    term.scrollToBottom()
    await writeLines(term, 40, 'replayed')
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    expect(term.buffer.active.baseY).toBeLessThan(91)

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(200)}`)
    expect(scheduler.scheduleCount()).toBe(0)
    scheduler.advance(SETTLE_MS)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })

  it('measures the pin from live coordinates, not stale durable ones', async () => {
    const term = await pinnedScrollbackTerminal()
    const scheduler = manualSettleScheduler()
    installTerminalLiveScrollbackRestore(term, {
      now: scheduler.now,
      scheduleSettle: scheduler.scheduleSettle
    })

    // Stored pre-remount intent can describe a taller buffer and the wrong live offset.
    term.clear()
    term.scrollToBottom()
    await writeLines(term, 40, 'replayed')
    term.scrollLines(-5)
    const liveOffset = term.buffer.active.baseY - term.buffer.active.viewportY
    expect(liveOffset).toBe(5)

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(200)}`)
    scheduler.advance(SETTLE_MS)

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(liveOffset)
  })

  it('restores after the private CSI ? 3 J erase', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[?3J${'after\r\n'.repeat(50)}`)
    settle()

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - bottomOffset)
  })

  it('does not arm for an erase on the alternate screen', async () => {
    const { term, settle, scheduleCount } = await pinnedTerminalWithRestore()
    const pinnedY = term.buffer.active.viewportY

    await write(term, '\x1b[?1049h\x1b[H\x1b[2J\x1b[3Jframe')
    expect(scheduleCount()).toBe(0)

    await write(term, '\x1b[?1049l')
    await writeLines(term, 60, 'after')
    settle()

    expect(term.buffer.active.viewportY).toBe(pinnedY)
  })

  it('drops the pin when the app switches to the alternate screen before it settles', async () => {
    const { term, settle } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(120)}`)
    await write(term, '\x1b[?1049h')
    const altY = term.buffer.active.viewportY
    settle()

    expect(term.buffer.active.viewportY).toBe(altY)
  })

  it('abandons the pin once the reader scrolls again', async () => {
    const { term, settle } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(120)}`)
    term.scrollLines(-2)
    markTerminalPinnedViewport(term)
    const afterUserScrollY = term.buffer.active.viewportY

    settle()
    expect(term.buffer.active.viewportY).toBe(afterUserScrollY)
  })

  it('cancels an armed pin on dispose', async () => {
    const term = await pinnedScrollbackTerminal()
    const scheduler = manualSettleScheduler()
    const restore = installTerminalLiveScrollbackRestore(term, {
      now: scheduler.now,
      scheduleSettle: scheduler.scheduleSettle
    })

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(120)}`)
    expect(scheduler.scheduleCount()).toBeGreaterThan(0)
    const cancelsBeforeDispose = scheduler.cancelCount()
    const clampedY = term.buffer.active.viewportY

    restore.dispose()
    expect(scheduler.cancelCount()).toBeGreaterThan(cancelsBeforeDispose)
    scheduler.advance(SETTLE_MS)
    expect(term.buffer.active.viewportY).toBe(clampedY)
  })

  it('stops observing erases after dispose', async () => {
    const { term, settle, restore } = await pinnedTerminalWithRestore()
    restore.dispose()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(50)}`)
    settle()
    // Without Orca’s pin, xterm’s erase releases reading position and follows the redraw.
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })
})

describe('live scrollback-erase pin wiring', () => {
  type StubRegistration = { id: { prefix?: string; final: string }; disposed: boolean }

  function stubTerminal(options: { throwOnBuffer?: boolean } = {}): {
    target: Parameters<typeof installTerminalLiveScrollbackRestore>[0]
    registrations: StubRegistration[]
    handlers: ((params: (number | number[])[]) => boolean)[]
    parsedDisposed: () => boolean
  } {
    const registrations: StubRegistration[] = []
    const handlers: ((params: (number | number[])[]) => boolean)[] = []
    let parsedDisposed = false
    const target = {
      get buffer() {
        if (options.throwOnBuffer) {
          throw new Error('buffer is gone')
        }
        return { active: { type: 'normal', viewportY: 10, baseY: 50 } }
      },
      parser: {
        registerCsiHandler: (
          id: { prefix?: string; final: string },
          handler: (params: (number | number[])[]) => boolean
        ) => {
          const registration: StubRegistration = { id, disposed: false }
          registrations.push(registration)
          handlers.push(handler)
          return {
            dispose: () => {
              registration.disposed = true
            }
          }
        }
      },
      onWriteParsed: () => ({
        dispose: () => {
          parsedDisposed = true
        }
      })
    }
    return {
      target: target as Parameters<typeof installTerminalLiveScrollbackRestore>[0],
      registrations,
      handlers,
      parsedDisposed: () => parsedDisposed
    }
  }

  it('degrades a throwing capture to "not handled" instead of wedging the parser', () => {
    const stub = stubTerminal({ throwOnBuffer: true })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installTerminalLiveScrollbackRestore(stub.target)

    // Parser handlers have no catch; one throw permanently wedges writes.
    for (const handler of stub.handlers) {
      expect(() => handler([3])).not.toThrow()
      expect(handler([3])).toBe(false)
    }
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
