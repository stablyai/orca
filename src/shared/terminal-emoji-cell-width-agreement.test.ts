/**
 * STA-6740: a cursor-position probe measured Orca advancing one cell for
 * sequences other terminals advance two for. These assert the advance the way
 * that probe does — by writing the bytes and reading where the cursor landed —
 * because the advance, not the glyph, is what a TUI budgets its columns
 * against, and a disagreement is what makes its next in-place redraw erase and
 * reprint over the wrong cells.
 *
 * The restore case pins the same measurement on the other side of
 * serialize/replay, so the snapshot path cannot grow a second width answer.
 */
import { describe, expect, it } from 'vitest'
import {
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  writeToTerminal,
  SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
  type ParityTerminal
} from './terminal-restore-parity-fixture'

/** Cells the cursor advanced for `text`, i.e. what CSI 6n would report. */
async function cursorAdvance(parity: ParityTerminal, text: string): Promise<number> {
  await writeToTerminal(parity.terminal, `\x1b[H\x1b[2J${text}`)
  return parity.terminal.buffer.active.cursorX
}

function createTerminal(): ParityTerminal {
  return createRendererParityTerminal({ cols: 80, rows: 24 })
}

// [label, sequence, expected cells]
const SEQUENCES: [string, string, number][] = [
  // Reported in STA-6740 as one cell in Orca, two elsewhere.
  ['desktop computer U+1F5A5 U+FE0F', '\u{1F5A5}️', 2],
  ['warning U+26A0 U+FE0F', '⚠️', 2],
  ['keycap U+0031 U+FE0F U+20E3', '1️⃣', 2],
  // A variation selector inside a ZWJ cluster is the same promotion, one level in.
  ['heart on fire U+2764 U+FE0F U+200D U+1F525', '❤️‍\u{1F525}', 2],
  // Same authority, same defect class: a modifier is part of its base's cluster.
  ['thumbs up + skin tone', '\u{1F44D}\u{1F3FD}', 2],
  ['person + skin tone + ZWJ role', '\u{1F9D1}\u{1F3FD}‍\u{1F4BB}', 2],
  // Emoji that postdate xterm's frozen Unicode 11 width table.
  ['melting face U+1FAE0', '\u{1FAE0}', 2],
  ['bubble tea U+1F9CB', '\u{1F9CB}', 2],
  ['playground slide U+1F6DD', '\u{1F6DD}', 2],
  // Controls the report measured as already correct — these must not move.
  ['CJK 中', '中', 2],
  ['check mark U+2705', '✅', 2],
  ['regional-indicator flag', '\u{1F1E8}\u{1F1F3}', 2],
  ['ZWJ family', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', 2],
  // A modifier only belongs to a base that takes one. After anything else it is
  // its own cluster, exactly as it was before this provider learned the rule.
  ['CJK + skin tone', '中\u{1F3FD}', 4],
  ['non-modifier-base emoji + skin tone', '\u{1F355}\u{1F3FD}', 4],
  ['ASCII + skin tone', 'a\u{1F3FD}', 3],
  // A variation selector after a non-emoji base is not a variation sequence.
  ['letter + U+FE0F', 'a️', 1],
  ['plain ASCII', 'ab', 2]
]

describe('terminal emoji cell width agreement (STA-6740)', () => {
  it.each(SEQUENCES)('advances the cursor %s cells for %s', async (_label, text, expected) => {
    const parity = createTerminal()
    expect(await cursorAdvance(parity, text)).toBe(expected)
    parity.terminal.dispose()
  })

  it('keeps the same advance after a snapshot is serialized and replayed', async () => {
    const live = createTerminal()
    const line = SEQUENCES.filter(([, , expected]) => expected > 0)
      .map(([, text]) => text)
      .join('')
    await writeToTerminal(live.terminal, `\x1b[H\x1b[2J${line}`)
    const liveCursor = live.terminal.buffer.active.cursorX
    const snapshot = buildParityMainBufferSnapshot(live, 1)

    const restored = createTerminal()
    await writeToTerminal(restored.terminal, SNAPSHOT_REPLAY_PREAMBLE_NORMAL)
    await writeToTerminal(restored.terminal, snapshot.data)

    expect(restored.terminal.buffer.active.cursorX).toBe(liveCursor)
    expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      live.terminal.buffer.active.getLine(0)?.translateToString(true)
    )
    live.terminal.dispose()
    restored.terminal.dispose()
  })

  it('reserves the second cell of a widened cluster instead of leaving it writable', async () => {
    // Why: advancing two cells is only half the contract. The second cell must
    // also be a wide-char placeholder, or the next glyph lands inside the
    // cluster and one of the two is overwritten.
    const parity = createTerminal()
    await writeToTerminal(parity.terminal, '\x1b[H\x1b[2J⚠️X')
    const line = parity.terminal.buffer.active.getLine(0)
    expect(line?.getCell(0)?.getWidth()).toBe(2)
    expect(line?.getCell(1)?.getWidth()).toBe(0)
    expect(line?.getCell(2)?.getChars()).toBe('X')
    parity.terminal.dispose()
  })
})
