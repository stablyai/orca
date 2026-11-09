import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'

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

  it('abandons the pin once the reader scrolls again', async () => {
    const { term, settle } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(120)}`)
    term.scrollLines(-2)
    markTerminalPinnedViewport(term)
    const afterUserScrollY = term.buffer.active.viewportY

    settle()
    expect(term.buffer.active.viewportY).toBe(afterUserScrollY)
  })
})
