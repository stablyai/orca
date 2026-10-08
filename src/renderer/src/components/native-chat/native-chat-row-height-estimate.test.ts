import { nativeChatAppearanceStyle } from './native-chat-appearance-style'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  estimateNativeChatRowHeight,
  estimateNativeChatTextLines,
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

const NO_CHROME = { hasReceipt: false, hasStatus: false, hasTurnDiff: false }

function message(text: string, role: NativeChatMessage['role'] = 'assistant'): NativeChatMessage {
  return {
    id: `m-${text.length}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('transcript row height estimate', () => {
  it('estimates a long prompt at its folded height, however long it runs', () => {
    const height = (lines: number, role: NativeChatMessage['role']): number =>
      estimateNativeChatRowHeight(
        nativeChatRowContentMetrics(message(Array(lines).fill('line').join('\n'), role)),
        NO_CHROME
      )
    expect(height(40, 'user')).toBe(height(400, 'user'))
    expect(height(40, 'user')).toBeLessThan(height(40, 'assistant'))
    expect(height(8, 'user')).toBeGreaterThan(height(7, 'user'))
    expect(height(400, 'user')).toBe(height(9, 'user'))
  })

  it('reuses row metrics across a one-pixel resize and refreshes after a substantial resize', () => {
    const prose = message('x'.repeat(900))
    const metricsAtWidth = (width: number) => {
      const style = nativeChatAppearanceStyle({ nativeChatAppearance: { width: 'wide' } }, width)
      return nativeChatRowContentMetrics(prose, {
        lineHeightPx: style['--chat-estimated-line-height'],
        charsPerLine: style['--chat-estimated-chars-per-line']
      })
    }
    const initial = metricsAtWidth(800)
    expect(metricsAtWidth(801)).toBe(initial)
    expect(metricsAtWidth(864)).not.toBe(initial)
  })

  it('adjusts line height and wrapping together for text size and column width', () => {
    const prose = message('x'.repeat(900))
    const height = (
      fontSize: number,
      width: 'comfortable' | 'wide' | 'full',
      columnWidth?: number
    ): number => {
      const style = nativeChatAppearanceStyle(
        { nativeChatAppearance: { fontSize, width } },
        columnWidth
      )
      const typography = {
        lineHeightPx: style['--chat-estimated-line-height'],
        charsPerLine: style['--chat-estimated-chars-per-line']
      }
      return estimateNativeChatRowHeight(
        nativeChatRowContentMetrics(prose, typography),
        NO_CHROME,
        typography
      )
    }
    expect(height(20, 'comfortable')).toBeGreaterThan(height(14, 'comfortable'))
    expect(height(12, 'comfortable')).toBeLessThan(height(14, 'comfortable'))
    expect(height(20, 'wide')).toBeLessThan(height(20, 'comfortable'))
    expect(height(20, 'full', 1200)).toBeLessThan(height(20, 'wide'))
    expect(height(14, 'comfortable')).toBe(
      estimateNativeChatRowHeight(nativeChatRowContentMetrics(prose), NO_CHROME)
    )
  })

  it('counts hard breaks and soft wraps as separate display lines', () => {
    expect(estimateNativeChatTextLines('')).toBe(0)
    expect(estimateNativeChatTextLines('one line')).toBe(1)
    expect(estimateNativeChatTextLines('one\ntwo\nthree')).toBe(3)
    // A single 300-character paragraph wraps rather than staying one line.
    expect(estimateNativeChatTextLines('x'.repeat(300))).toBeGreaterThan(1)
    // A blank line still occupies one.
    expect(estimateNativeChatTextLines('a\n\nb')).toBe(3)
  })

  it('grows with the prose it is estimating', () => {
    const short = estimateNativeChatRowHeight(
      nativeChatRowContentMetrics(message('one line')),
      NO_CHROME
    )
    const long = estimateNativeChatRowHeight(
      nativeChatRowContentMetrics(message(Array.from({ length: 40 }, () => 'line').join('\n'))),
      NO_CHROME
    )
    expect(long).toBeGreaterThan(short)
  })

  it('bounds the estimate at both ends', () => {
    const empty = estimateNativeChatRowHeight(nativeChatRowContentMetrics(message('')), NO_CHROME)
    const enormous = estimateNativeChatRowHeight(
      nativeChatRowContentMetrics(message('line\n'.repeat(5000))),
      NO_CHROME
    )
    expect(empty).toBeGreaterThan(0)
    expect(enormous).toBeLessThan(5000 * 22)
  })

  // The gap between rows belongs to the window, which puts one between every
  // pair. A row that also charged for it would sit one gap lower than the row
  // above it, and the drift compounds the whole way down the transcript.
  //
  // Stated without naming any constant: a prose row is its lines and nothing
  // else, so its estimate has to be exactly its line count times what one more
  // line costs. Any fixed amount riding along — a gap above all — breaks that.
  it('charges a prose row for its lines and for nothing else', () => {
    const lines = (count: number): number =>
      estimateNativeChatRowHeight(
        nativeChatRowContentMetrics(message(Array.from({ length: count }, () => 'x').join('\n'))),
        NO_CHROME
      )
    const perLine = lines(10) - lines(9)

    expect(perLine).toBeGreaterThan(0)
    expect(lines(10)).toBe(10 * perLine)
  })

  // The parts stacked INSIDE one row do pay for the gap between them, because
  // that gap is inside the height the row will be measured at.
  it('charges a row for the gap above a turn status it carries', () => {
    const metrics = nativeChatRowContentMetrics(message('one line'))
    const bare = estimateNativeChatRowHeight(metrics, NO_CHROME)
    const withStatus = estimateNativeChatRowHeight(metrics, { ...NO_CHROME, hasStatus: true })

    expect(withStatus - bare).toBeGreaterThan(NATIVE_CHAT_ROW_GAP_PX)
  })

  it('does not add a leading gap to status-only or diff-only rows', () => {
    const empty = nativeChatRowContentMetrics(message(''))
    const bare = estimateNativeChatRowHeight(empty, NO_CHROME)
    const statusOnly = estimateNativeChatRowHeight(empty, { ...NO_CHROME, hasStatus: true })
    const diffOnly = estimateNativeChatRowHeight(empty, { ...NO_CHROME, hasTurnDiff: true })

    expect(statusOnly).toBe(diffOnly)
    expect(statusOnly - bare).toBeLessThan(NATIVE_CHAT_ROW_GAP_PX)
  })

  it('includes both rendered parts and their gap for a receipt carrying a diff', () => {
    const empty = nativeChatRowContentMetrics(message(''))
    const receipt = estimateNativeChatRowHeight(empty, {
      hasReceipt: true,
      hasStatus: false,
      hasTurnDiff: false
    })
    const diff = estimateNativeChatRowHeight(empty, {
      hasReceipt: false,
      hasStatus: false,
      hasTurnDiff: true
    })
    const together = estimateNativeChatRowHeight(empty, {
      hasReceipt: true,
      hasStatus: false,
      hasTurnDiff: true
    })

    expect(together).toBe(receipt + NATIVE_CHAT_ROW_GAP_PX + diff)
  })

  it("reserves a section's prose row the controls it keeps in flow", () => {
    // Two lines, so the row's minimum height does not absorb the difference.
    const prose = nativeChatRowContentMetrics(message('one\ntwo'))
    const reasoning = nativeChatRowContentMetrics(message('one\ntwo', 'reasoning'))
    const inSection = { ...NO_CHROME, inSubagentSection: true }

    expect(
      estimateNativeChatRowHeight(prose, inSection) - estimateNativeChatRowHeight(prose, NO_CHROME)
    ).toBe(20)
    // Reasoning draws no controls.
    expect(estimateNativeChatRowHeight(reasoning, inSection)).toBe(
      estimateNativeChatRowHeight(reasoning, NO_CHROME)
    )
  })

  it('charges a long reasoning row only for the one-line trigger it shows collapsed', () => {
    const summary = 'x'.repeat(4_129)
    const reasoning = estimateNativeChatRowHeight(
      nativeChatRowContentMetrics(message(summary, 'reasoning')),
      NO_CHROME
    )
    expect(reasoning).toBe(24)
    expect(
      estimateNativeChatRowHeight(nativeChatRowContentMetrics(message(summary)), NO_CHROME)
    ).toBeGreaterThan(900)
  })

  it('reuses one derivation per message', () => {
    const subject = message('cached')
    expect(nativeChatRowContentMetrics(subject)).toBe(nativeChatRowContentMetrics(subject))
  })

  it('keeps role-specific chrome when two messages share their blocks', () => {
    const blocks: NativeChatMessage['blocks'] = [{ type: 'text', text: 'same content' }]
    const withRole = (role: NativeChatMessage['role']): NativeChatMessage => ({
      ...message('same content', role),
      blocks
    })

    expect(nativeChatRowContentMetrics(withRole('user')).role).toBe('user')
    expect(nativeChatRowContentMetrics(withRole('assistant')).role).toBe('assistant')
  })

  it('reserves more for a row carrying a tool run than for its prose alone', () => {
    const prose = nativeChatRowContentMetrics(message('ran something'))
    const withTool = nativeChatRowContentMetrics({
      id: 'tool',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'ran something' },
        { type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }
      ],
      timestamp: 1,
      source: 'transcript'
    })
    expect(estimateNativeChatRowHeight(withTool, NO_CHROME)).toBeGreaterThan(
      estimateNativeChatRowHeight(prose, NO_CHROME)
    )
  })

  it('reserves a bounded two-line tool header across supported text sizes', () => {
    const estimates = [12, 14, 20].map((fontSize) => {
      const style = nativeChatAppearanceStyle({ nativeChatAppearance: { fontSize } })
      const typography = {
        lineHeightPx: style['--chat-estimated-line-height'],
        charsPerLine: style['--chat-estimated-chars-per-line']
      }
      const heightFor = (command: string): number =>
        estimateNativeChatRowHeight(
          nativeChatRowContentMetrics({
            id: command,
            role: 'assistant',
            blocks: [{ type: 'tool-call', name: 'shell', input: { command }, state: 'completed' }],
            timestamp: 1,
            source: 'transcript'
          }),
          NO_CHROME,
          typography
        )
      const estimate = heightFor('x'.repeat(5000))

      expect(estimate).toBe(heightFor('ls'))
      expect(estimate).toBeGreaterThan(2 * typography.lineHeightPx)
      expect(estimate).toBeLessThan(2 * typography.lineHeightPx + 24)
      return estimate
    })

    expect(estimates[0]).toBeLessThan(estimates[1])
    expect(estimates[1]).toBeLessThan(estimates[2])
  })

  it('grows the collapsed reasoning trigger with chat text size above its floor', () => {
    const reasoning = nativeChatRowContentMetrics(message('thinking', 'reasoning'))
    const [small, standard, large] = [12, 14, 20].map((fontSize) => {
      const style = nativeChatAppearanceStyle({ nativeChatAppearance: { fontSize } })
      return estimateNativeChatRowHeight(reasoning, NO_CHROME, {
        lineHeightPx: style['--chat-estimated-line-height'],
        charsPerLine: style['--chat-estimated-chars-per-line']
      })
    })

    expect(small).toBe(24)
    expect(standard).toBe(24)
    expect(large).toBeGreaterThan(standard)
  })
})
