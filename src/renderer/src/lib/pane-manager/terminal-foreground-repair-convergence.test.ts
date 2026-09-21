import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'

import {
  discardForegroundRenderSettle,
  writeForegroundTerminalChunk,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'

/**
 * Convergence oracle for the narrowed foreground repaint.
 *
 * Invariant (`terminal-geometry.visible-convergence`): the rows Orca asks xterm
 * to repaint after a forced foreground refresh must cover every viewport row
 * whose rendered content changed during that write, plus the cursor row on both
 * sides of it. A renderer whose model was converged before the write is then
 * still converged after it, so narrowing the span can never strand a stale cell.
 *
 * A `null` span means "repaint the whole viewport" and trivially converges; the
 * corpus below also asserts which cases must stay full-grid.
 */

type SpanRequest = { start: number; end: number }

type Harness = {
  terminal: Terminal
  target: ForegroundTerminalOutputTarget
  requests: SpanRequest[]
}

function createHarness(cols = 80, rows = 24): Harness {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  const requests: SpanRequest[] = []
  const target = terminal as unknown as ForegroundTerminalOutputTarget & {
    refresh: (start: number, end: number) => void
  }
  target.refresh = (start: number, end: number) => {
    requests.push({ start, end })
  }
  return { terminal, target, requests }
}

function serializeRow(terminal: Terminal, viewportRow: number): string {
  // Why the offset: `getLine` indexes the whole buffer, so viewport row 0 is the
  // line at `viewportY`. Comparing raw buffer indices would compare scrollback
  // that no write can touch and make the oracle vacuous.
  const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + viewportRow)
  if (!line) {
    return '<missing>'
  }
  const parts: string[] = []
  for (let x = 0; x < terminal.cols; x++) {
    const cell = line.getCell(x)
    if (!cell) {
      parts.push('~')
      continue
    }
    parts.push(
      [
        cell.getChars(),
        cell.getWidth(),
        cell.getFgColorMode(),
        cell.getFgColor(),
        cell.getBgColorMode(),
        cell.getBgColor(),
        cell.isBold(),
        cell.isItalic(),
        cell.isDim(),
        cell.isUnderline(),
        cell.isBlink(),
        cell.isInverse(),
        cell.isInvisible(),
        cell.isStrikethrough(),
        cell.isOverline()
      ].join(':')
    )
  }
  return parts.join('|')
}

function snapshotViewport(terminal: Terminal): string[] {
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) {
    rows.push(serializeRow(terminal, y))
  }
  return rows
}

function changedRows(before: string[], after: string[]): number[] {
  const changed: number[] = []
  for (let y = 0; y < Math.max(before.length, after.length); y++) {
    if (before[y] !== after[y]) {
      changed.push(y)
    }
  }
  return changed
}

async function writeAndSettle(harness: Harness, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const accepted = writeForegroundTerminalChunk(harness.target, data, {
      forceViewportRefresh: true,
      // Why: headless has no `_core.refresh`, so drive the public `refresh` path
      // the WebGL/async branch uses in the app.
      shouldRefreshViewportSynchronously: () => false,
      onParsed: () => resolve()
    })
    expect(accepted).toBe(true)
  })
}

/** Seed the pane without measuring: plain writes, drained before the oracle runs. */
async function seed(harness: Harness, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    harness.terminal.write(data, () => resolve())
  })
}

type Case = {
  name: string
  setup?: string
  write: string
  /** Whole-viewport repaint is required (scroll, buffer flip, unknown span). */
  expectFullGrid?: boolean
  cols?: number
  rows?: number
}

const SCROLLBACK_SEED = `${Array.from({ length: 40 }, (_, i) => `line ${i} ${'lorem ipsum '.repeat(3)}`).join('\r\n')}\r\n\r\n\r\n\r\n`

const CLAUDE_STYLE_REDRAW = `\x1b[?25l\x1b[4A\x1b[2K* Thinking… (12s)\r\n\x1b[2K  > tool call 3\r\n\x1b[2K  ${'#'.repeat(30)}\r\n\x1b[2K\r\n\x1b[?25h`

const CASES: Case[] = [
  {
    name: 'claude-style in-place redraw of the bottom rows',
    setup: SCROLLBACK_SEED,
    write: CLAUDE_STYLE_REDRAW
  },
  {
    name: 'standalone carriage-return overwrite of the current line',
    setup: `${SCROLLBACK_SEED}some existing prompt text`,
    write: '\rrewritten prompt'
  },
  {
    name: 'backspace erase',
    setup: `${SCROLLBACK_SEED}abcdef`,
    write: '\b\b\b   \b\b\b'
  },
  {
    name: 'erase in line to end',
    setup: `${SCROLLBACK_SEED}${'x'.repeat(70)}`,
    write: '\x1b[20G\x1b[K'
  },
  {
    name: 'erase in line, whole line',
    setup: `${SCROLLBACK_SEED}${'x'.repeat(70)}`,
    write: '\x1b[2K'
  },
  {
    name: 'erase in display from mid-screen to end',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 10 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\r\n')}`,
    write: '\x1b[12;5H\x1b[J'
  },
  {
    name: 'erase in display, above cursor',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 10 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\r\n')}`,
    write: '\x1b[12;5H\x1b[1J'
  },
  {
    name: 'full clear then home',
    setup: SCROLLBACK_SEED,
    write: '\x1b[2J\x1b[H'
  },
  {
    name: 'wide CJK glyphs rewritten in place',
    setup: `${SCROLLBACK_SEED}${'漢字テスト'.repeat(6)}`,
    write: '\r\x1b[2K中文字符测试中文字符测试'
  },
  {
    name: 'emoji rewritten in place',
    setup: `${SCROLLBACK_SEED}status: 🚀🚀🚀 building`,
    write: '\r\x1b[2Kstatus: ✅ done 🎉'
  },
  {
    name: 'combining characters rewritten in place',
    setup: `${SCROLLBACK_SEED}café naiÌˆve`,
    write: '\r\x1b[2Kcafé́ é̀̂ done'
  },
  {
    name: 'zero-width-joiner sequence',
    setup: `${SCROLLBACK_SEED}team: `,
    write: '\r\x1b[2Kteam: \u{1F469}‍\u{1F4BB} \u{1F468}‍\u{1F373}'
  },
  {
    name: 'insert lines inside a scroll region',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `region ${i}`).join('\r\n')}`,
    write: '\x1b[5;18r\x1b[8;1H\x1b[3L\x1b[r'
  },
  {
    name: 'delete lines inside a scroll region',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `region ${i}`).join('\r\n')}`,
    write: '\x1b[5;18r\x1b[8;1H\x1b[3M\x1b[r'
  },
  {
    name: 'reverse index at the top of the screen scrolls content down',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `ri ${i}`).join('\r\n')}`,
    write: '\x1b[1;1H\x1bM\x1bM'
  },
  {
    name: 'cursor jump then paint on a far row',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `jump ${i}`).join('\r\n')}`,
    write: '\x1b[2;5Hpainted far away\x1b[K'
  },
  {
    name: 'DEC synchronized-output frame touching scattered rows',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 20 }, (_, i) => `tui ${i}`).join('\r\n')}`,
    write:
      '\x1b[?2026h\x1b[?25l\x1b[1;2H\x1b[38;2;255;138;0m/ agent\x1b[0m\x1b[9;4Hbody row\x1b[K\x1b[23;2Hstream 0001\x1b[K\x1b[?25h\x1b[?2026l'
  },
  {
    name: 'newline past the bottom scrolls the viewport',
    setup: SCROLLBACK_SEED,
    write: '\x1b[2Kfresh output line\r\n',
    expectFullGrid: true
  },
  {
    name: 'entering the alternate screen',
    setup: SCROLLBACK_SEED,
    write: '\x1b[?1049h\x1b[2J\x1b[H\x1b[Khello alt screen',
    expectFullGrid: true
  },
  {
    name: 'leaving the alternate screen',
    setup: `${SCROLLBACK_SEED}\x1b[?1049h\x1b[2J\x1b[Halt content\x1b[K`,
    write: '\x1b[?1049l\x1b[2K',
    expectFullGrid: true
  },
  {
    name: 'narrow pane, full-width in-place rewrite',
    cols: 40,
    rows: 12,
    setup: 'z'.repeat(38),
    write: `\r\x1b[2K${'q'.repeat(38)}`
  }
]

describe('foreground repaint convergence', () => {
  for (const testCase of CASES) {
    it(`covers every changed row: ${testCase.name}`, async () => {
      const harness = createHarness(testCase.cols ?? 80, testCase.rows ?? 24)
      if (testCase.setup) {
        await seed(harness, testCase.setup)
      }
      const before = snapshotViewport(harness.terminal)
      const cursorBefore = harness.terminal.buffer.active.cursorY
      harness.requests.length = 0

      await writeAndSettle(harness, testCase.write)

      const after = snapshotViewport(harness.terminal)
      const cursorAfter = harness.terminal.buffer.active.cursorY
      expect(harness.requests.length).toBeGreaterThan(0)

      const request = harness.requests[0]!
      const isFullGrid = request.start === 0 && request.end === harness.terminal.rows - 1
      if (testCase.expectFullGrid) {
        expect(isFullGrid).toBe(true)
      }

      const dirty = changedRows(before, after)
      // Guard against a vacuous oracle: every corpus entry must move the screen.
      expect(dirty.length).toBeGreaterThan(0)
      for (const row of dirty) {
        expect(
          row >= request.start && row <= request.end,
          `row ${row} changed but repaint span was ${request.start}..${request.end}`
        ).toBe(true)
      }
      // The cursor row must be repainted: xterm's WebGL model drops the caret
      // whenever an update pass excludes it.
      expect(cursorBefore).toBeGreaterThanOrEqual(request.start)
      expect(cursorBefore).toBeLessThanOrEqual(request.end)
      expect(cursorAfter).toBeGreaterThanOrEqual(request.start)
      expect(cursorAfter).toBeLessThanOrEqual(request.end)

      discardForegroundRenderSettle(harness.target)
      harness.terminal.dispose()
    })
  }

  it('narrows an in-place bottom-row redraw well below the full grid', async () => {
    const harness = createHarness(80, 40)
    await seed(harness, SCROLLBACK_SEED)
    harness.requests.length = 0
    await writeAndSettle(harness, CLAUDE_STYLE_REDRAW)
    const request = harness.requests[0]!
    // Bottom-anchored redraw: the span ends on the cursor row but stays a few
    // rows tall instead of the 40-row grid the old repair requested.
    expect(request.end - request.start + 1).toBeLessThanOrEqual(8)
    expect(request.start).toBeGreaterThan(0)
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })

  it('widens the repair to the cursor rows on both sides of the write', () => {
    // Why a double: xterm's own tracker always happens to include the cursor
    // row, so only a controlled parse span can prove Orca adds it itself. The
    // WebGL model drops the caret when an update pass excludes the cursor row.
    const requests: SpanRequest[] = []
    let fire: (event: { start: number; end: number } | undefined) => void = () => {}
    const active = { type: 'normal', cursorY: 2, baseY: 0, viewportY: 0 }
    const target: ForegroundTerminalOutputTarget = {
      rows: 24,
      buffer: { active },
      refresh: (start, end) => requests.push({ start, end }),
      write: (_data, callback) => {
        fire({ start: 8, end: 9 })
        active.cursorY = 17
        callback?.()
      },
      _core: {
        _inputHandler: {
          onRequestRefreshRows: (listener) => {
            fire = listener
            return { dispose: () => {} }
          }
        }
      }
    } as unknown as ForegroundTerminalOutputTarget
    writeForegroundTerminalChunk(target, 'x', {
      forceViewportRefresh: true,
      shouldRefreshViewportSynchronously: () => false
    })
    expect(requests).toEqual([{ start: 2, end: 17 }])
  })

  it('repaints the whole viewport when the parse span cannot be observed', async () => {
    const requests: SpanRequest[] = []
    const target: ForegroundTerminalOutputTarget = {
      rows: 24,
      buffer: {
        active: { type: 'normal', cursorY: 3, baseY: 0, viewportY: 0 }
      },
      refresh: (start, end) => requests.push({ start, end }),
      write: (_data, callback) => callback?.()
    }
    writeForegroundTerminalChunk(target, 'x', {
      forceViewportRefresh: true,
      shouldRefreshViewportSynchronously: () => false
    })
    expect(requests).toEqual([{ start: 0, end: 23 }])
  })

  it('keeps the follow-up settle repaint on the whole viewport', async () => {
    const harness = createHarness(80, 24)
    await seed(harness, SCROLLBACK_SEED)
    harness.requests.length = 0
    await writeAndSettle(harness, 'scrolling output\r\n')
    // Primary repaint is full-grid because the viewport scrolled.
    expect(harness.requests[0]).toEqual({ start: 0, end: 23 })
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })
})
