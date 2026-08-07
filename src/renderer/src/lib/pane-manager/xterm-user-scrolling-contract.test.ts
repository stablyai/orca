/**
 * Contract test for xterm's native user-scrolling ownership (vendored
 * 6.1.0-beta.287; @xterm/headless shares BufferService with @xterm/xterm).
 *
 * Orca's live PTY write path performs NO scroll-intent enforcement — it
 * relies on xterm core keeping a scrolled-up viewport stable and following
 * output at the bottom (BufferService.isUserScrolling, consumed atomically
 * inside scroll()). App-side enforcement is scoped to structural operations
 * (snapshot replay, remount, fit reflow) in terminal-scroll-intent.ts.
 *
 * If an xterm upgrade breaks any assertion here, the live write path loses
 * its follow/pin semantics silently — fix the write path before bumping.
 */
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import packageJson from '../../../../../package.json'
import { clearTerminalScrollbackAndFollowOutput } from './terminal-scrollback-clear'
import { installTerminalLiveScrollbackRestore } from './terminal-live-scrollback-restore'
import { markTerminalFollowOutput, markTerminalPinnedViewport } from './terminal-scroll-intent'

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
  await writeLines(term, 100, 'before')
  term.scrollLines(-30)
  markTerminalPinnedViewport(term)
  return term
}

describe('xterm native user-scrolling contract (vendored 6.1.0-beta.287)', () => {
  it('pins headless and renderer xterm to the same version', () => {
    expect(packageJson.dependencies['@xterm/headless']).toBe(
      packageJson.devDependencies['@xterm/xterm']
    )
  })

  it('keeps a scrolled-up viewport stable while output is written', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active
    expect(buffer.viewportY).toBe(buffer.baseY)

    term.scrollLines(-5)
    const pinnedY = buffer.viewportY
    expect(pinnedY).toBe(buffer.baseY - 5)

    await writeLines(term, 10, 'more')
    expect(buffer.viewportY).toBe(pinnedY)
    expect(buffer.baseY).toBe(pinnedY + 15)
  })

  it('treats a viewport one row above bottom as user-scrolling through output', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active

    term.scrollLines(-1)
    const pinnedY = buffer.viewportY
    expect(pinnedY).toBe(buffer.baseY - 1)
    expect(term._core?._bufferService?.isUserScrolling).toBe(true)

    await writeLines(term, 5, 'more')
    expect(buffer.viewportY).toBe(pinnedY)
  })

  it('follows output at the bottom and re-follows after scrolling back down', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active

    await writeLines(term, 5, 'tail')
    expect(buffer.viewportY).toBe(buffer.baseY)

    term.scrollLines(-5)
    term.scrollToBottom()
    await writeLines(term, 5, 'after')
    expect(buffer.viewportY).toBe(buffer.baseY)
  })

  it('applies scrollOnUserInput before notifying onData listeners', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active
    term.scrollLines(-5)
    let viewportSeenByOnData = -1
    const subscription = term.onData(() => {
      viewportSeenByOnData = buffer.viewportY
    })

    term.input('a', true)

    // Why: Orca resyncs typing intent synchronously from onData, so this
    // xterm ordering is part of the pinned-version contract.
    expect(viewportSeenByOnData).toBe(buffer.baseY)
    subscription.dispose()
  })

  it('distinguishes real user input from parser auto-replies', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      allowProposedApi: true
    }) as TerminalWithBufferService
    expect(term._core?.coreService?.onUserInput).toBeTypeOf('function')
    let userInputCount = 0
    const subscription = term._core?.coreService?.onUserInput?.(() => {
      userInputCount += 1
    })

    term.input('a', true)
    await write(term, '\x1b[6n')

    expect(userInputCount).toBe(1)
    subscription?.dispose()
  })

  it('walks a pinned viewport down content-stably when scrollback trims', async () => {
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 20, allowProposedApi: true })
    await writeLines(term, 30, 'x')
    const buffer = term.buffer.active
    term.scrollLines(-10)
    const pinnedY = buffer.viewportY
    const fullBaseY = buffer.baseY

    await writeLines(term, 10, 'trim')
    // Buffer is at capacity: baseY stays put while each trimmed line shifts
    // the pinned viewport up by one so the visible content does not move.
    expect(buffer.baseY).toBe(fullBaseY)
    expect(buffer.viewportY).toBe(Math.max(0, pinnedY - 10))
  })

  it('exposes the isUserScrolling flag the structural restore paths depend on', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    const bufferService = term._core?._bufferService
    expect(typeof bufferService?.isUserScrolling).toBe('boolean')

    // scrollLines/scrollToBottom self-manage the flag, so Orca's programmatic
    // scroll restores inherit xterm's native live-output ownership.
    expect(bufferService?.isUserScrolling).toBe(false)
    term.scrollLines(-5)
    expect(bufferService?.isUserScrolling).toBe(true)
    term.scrollToBottom()
    expect(bufferService?.isUserScrolling).toBe(false)
  })

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

/**
 * Drives the settle timer off a virtual clock so tests can prove the debounce
 * itself. Every schedule is its own live timer, as with setTimeout, so a
 * missing cancel shows up as an extra timer firing rather than being absorbed.
 */
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
      // A regression that re-arms with no delay would otherwise spin here and
      // read as a stuck CI job rather than a failing assertion.
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
    expect(term.buffer.active.viewportY).toBe(0)
    settle()

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - bottomOffset)
    expect(term._core?._bufferService?.isUserScrolling).toBe(true)
  })

  it('triggers on a bare erase-scrollback with no screen clear alongside it', async () => {
    const { term, settle, bottomOffset, scheduleCount } = await pinnedTerminalWithRestore()

    // No \x1b[2J prefix: the scrollback erase alone is the trigger.
    await write(term, `\x1b[3J${'after\r\n'.repeat(150)}`)
    expect(scheduleCount()).toBeGreaterThan(0)
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
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
    // Grow the buffer so a spurious bottom-offset restore would be visible.
    await writeLines(term, 200, 'after')
    expect(scheduleCount()).toBe(0)
    settle()

    expect(term.buffer.active.viewportY).toBe(pinnedY)
  })

  it('detects a clear split across writes', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    // xterm's parser carries the half-parsed sequence across the write boundary.
    await write(term, '\x1b[2J\x1b[H\x1b[')
    await write(term, `3J${'after\r\n'.repeat(50)}`)
    settle()

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - bottomOffset)
  })

  it('holds the pin while the redraw keeps arriving and lands it once quiet', async () => {
    const { term, advance, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(60)}`)
    // Each frame lands inside the quiet period, so the pin must not fire yet.
    for (let frame = 0; frame < 5; frame += 1) {
      advance(SETTLE_MS - 60)
      expect(term.buffer.active.viewportY).toBe(0)
      await write(term, 'after\r\n'.repeat(40))
    }
    advance(SETTLE_MS)

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('lands the pin after a redraw that outgrows the erased scrollback over several writes', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    // Each batch alone would settle the pin at the wrong distance from the bottom.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(101)}`)
    await write(term, 'after\r\n'.repeat(199))
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('survives a mid-redraw write that adds no rows', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(50)}`)
    // A cursor/attribute-only frame is normal mid-repaint and must not end the pin.
    await write(term, '\x1b[K')
    await write(term, 'after\r\n'.repeat(250))
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('spends the pin once even when the rebuild stays shorter than the old scrollback', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    // A rebuild shorter than the pre-erase buffer skips the intent re-latch, so
    // only the single-shot disarm stops this from becoming a follow-at-offset.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(60)}`)
    settle()
    const restoredY = term.buffer.active.viewportY
    expect(restoredY).toBe(term.buffer.active.baseY - bottomOffset)

    await writeLines(term, 200, 'later')
    settle()
    expect(term.buffer.active.viewportY).toBe(restoredY)
  })

  it('does not drag the reader through output that arrives after the pin lands', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(120)}`)
    settle()
    const restoredY = term.buffer.active.viewportY
    expect(restoredY).toBe(term.buffer.active.baseY - bottomOffset)

    // The pin is spent: the reader holds position while the program keeps printing.
    await writeLines(term, 200, 'later')
    settle()
    expect(term.buffer.active.viewportY).toBe(restoredY)
  })

  it('measures the pin from the rows already written earlier in the same chunk', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()
    const rowsBeforeErase = 20

    // Those rows push the reader further from the bottom before the erase runs;
    // capturing at the write boundary instead would undercount them.
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

    // The first redraw regrows past a screenful, so at the second erase the
    // reader reads as detached at line 0. Re-measuring there would capture the
    // whole rebuilt height as the offset and strand them at the top.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'first\r\n'.repeat(160)}`)
    expect(term.buffer.active.viewportY).toBe(0)
    expect(term.buffer.active.baseY).toBeGreaterThan(0)

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'second\r\n'.repeat(160)}`)
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it("re-captures from the reader's new position when they move between two erases", async () => {
    const { term, advance, scheduleCount } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'first\r\n'.repeat(300)}`)
    expect(scheduleCount()).toBeGreaterThan(0)

    // The reader moves during the rebuild, so the armed pin is superseded and
    // the next erase has to measure them where they are now.
    term.scrollLines(250)
    markTerminalPinnedViewport(term)
    const movedOffset = term.buffer.active.baseY - term.buffer.active.viewportY

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'second\r\n'.repeat(300)}`)
    advance(2_000)

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(movedOffset)
  })

  it('keeps one deadline across a repeating clear so the pin still lands', async () => {
    const { term, advance, bottomOffset } = await pinnedTerminalWithRestore()

    // A clear loop re-arms faster than the settle, so the pin only ever lands
    // because the deadline stays anchored to the first erase. Ten 100ms cycles
    // reach MAX_PENDING_RESTORE_MS exactly.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await write(term, `\x1b[2J\x1b[H\x1b[3J${'redraw\r\n'.repeat(140)}`)
      expect(term.buffer.active.viewportY).toBe(0)
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

    // Land inside 0 < baseY < bottomOffset, the band a partial rebuild sits in.
    await write(term, `\x1b[2J\x1b[H\x1b[3J${'partial\r\n'.repeat(20)}`)
    expect(term.buffer.active.baseY).toBeGreaterThan(0)
    expect(term.buffer.active.baseY).toBeLessThan(bottomOffset)

    advance(2_000)
    const schedulesAfterGiveUp = scheduleCount()
    // The erase already clamped the reader here; giving up must not move them.
    expect(term.buffer.active.viewportY).toBe(0)

    // The pin is spent, so a later rebuild tall enough to honor it must not fire.
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

    // A remount/replay leaves the live buffer shorter than the durable pin, so
    // capture prefers the stored pre-remount coordinates even though the reader
    // is now following live output at the bottom.
    term.clear()
    term.scrollToBottom()
    await writeLines(term, 40, 'replayed')
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    expect(term.buffer.active.baseY).toBeLessThan(91)

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(200)}`)
    // No pin is armed at all, so nothing can later pull them off the bottom.
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

    // A remount/replay leaves the durable intent describing a taller buffer than
    // the one on screen, so its offset no longer matches what the reader sees.
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

    // xterm routes the private form to its own handler and it erases scrollback too.
    await write(term, `\x1b[2J\x1b[H\x1b[?3J${'after\r\n'.repeat(50)}`)
    settle()

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - bottomOffset)
  })

  it('restores after the subparameter erase form', async () => {
    const { term, settle, bottomOffset } = await pinnedTerminalWithRestore()

    await write(term, `\x1b[2J\x1b[H\x1b[3:1J${'after\r\n'.repeat(120)}`)
    settle()

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
  })

  it('does not arm for an erase on the alternate screen', async () => {
    const { term, settle, scheduleCount } = await pinnedTerminalWithRestore()
    const pinnedY = term.buffer.active.viewportY

    await write(term, '\x1b[?1049h\x1b[H\x1b[2J\x1b[3Jframe')
    expect(scheduleCount()).toBe(0)

    await write(term, '\x1b[?1049l')
    await writeLines(term, 60, 'after')
    settle()

    // xterm carries the pin itself; a restore firing here would drag the reader.
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

  it('leaves a follow-output pane following', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 100, 'before')
    markTerminalFollowOutput(term)
    const scheduler = manualSettleScheduler()
    installTerminalLiveScrollbackRestore(term, {
      now: scheduler.now,
      scheduleSettle: scheduler.scheduleSettle
    })

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(50)}`)
    expect(scheduler.scheduleCount()).toBe(0)
    scheduler.advance(SETTLE_MS)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
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
    // The live timer is released, not just neutered, so nothing survives the pane.
    expect(scheduler.cancelCount()).toBeGreaterThan(cancelsBeforeDispose)
    scheduler.advance(SETTLE_MS)
    expect(term.buffer.active.viewportY).toBe(clampedY)
  })

  it('stops observing erases after dispose', async () => {
    const { term, settle, restore } = await pinnedTerminalWithRestore()
    restore.dispose()

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(50)}`)
    settle()
    // Without the pin the reader is stranded where the erase clamped them.
    expect(term.buffer.active.viewportY).toBe(0)
  })

  it('lands the pin on the real timer when no scheduler is injected', async () => {
    const term = await pinnedScrollbackTerminal()
    const restore = installTerminalLiveScrollbackRestore(term)
    const bottomOffset = term.buffer.active.baseY - term.buffer.active.viewportY

    await write(term, `\x1b[2J\x1b[H\x1b[3J${'after\r\n'.repeat(120)}`)
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(term.buffer.active.baseY - term.buffer.active.viewportY).toBe(bottomOffset)
    restore.dispose()
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

  it('registers both the plain and private erase idents', () => {
    const stub = stubTerminal()
    installTerminalLiveScrollbackRestore(stub.target)

    expect(stub.registrations.map((registration) => registration.id)).toEqual([
      { final: 'J' },
      { prefix: '?', final: 'J' }
    ])
  })

  it('degrades a throwing capture to "not handled" instead of wedging the parser', () => {
    const stub = stubTerminal({ throwOnBuffer: true })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installTerminalLiveScrollbackRestore(stub.target)

    // xterm has no try/catch around parser handlers, so a throw here would stop
    // the pane's write pipeline for good.
    for (const handler of stub.handlers) {
      expect(() => handler([3])).not.toThrow()
      expect(handler([3])).toBe(false)
    }
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('releases both registrations and the parsed subscription on dispose', () => {
    const stub = stubTerminal()
    const restore = installTerminalLiveScrollbackRestore(stub.target)

    restore.dispose()
    expect(stub.registrations.every((registration) => registration.disposed)).toBe(true)
    expect(stub.parsedDisposed()).toBe(true)
  })

  it('does nothing when the terminal exposes no parser or parsed event', () => {
    const restore = installTerminalLiveScrollbackRestore({
      buffer: { active: { type: 'normal', viewportY: 10, baseY: 50 } }
    } as Parameters<typeof installTerminalLiveScrollbackRestore>[0])
    expect(() => restore.dispose()).not.toThrow()
  })
})
