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

  it('reuses one derivation per block set', () => {
    const subject = message('cached')
    expect(nativeChatRowContentMetrics(subject)).toBe(nativeChatRowContentMetrics(subject))
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
})
