import { describe, expect, it } from 'vitest'
import { MAX_OSC_TITLE_CHARS as DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT } from './osc-title-extraction'
import {
  getDecorativeAgentTitleSignature,
  getDecorativeTitleGateKey,
  isDecorativeAgentTitleFrameChange
} from './agent-decorative-title-signature'

const BRAILLE_SPINNER_FRAME_A = String.fromCharCode(0x280b)

describe('agent decorative title signatures', () => {
  it('folds a spinner frame repeated inside the title (Codex)', () => {
    // Codex 0.155.1 titles, as recorded: the frame leads and repeats before the folder.
    expect(
      isDecorativeAgentTitleFrameChange(
        '\u2819 renaming... \u2819 | scratch',
        '\u2839 renaming... \u2839 | scratch'
      )
    ).toBe(true)
    expect(getDecorativeAgentTitleSignature('\u2819 renaming... \u2819 | scratch')).toBe(
      'working:renaming... | scratch'
    )
    // The runtime's session-tabs gate: equal keys publish nothing new.
    const first = '\u2819 renaming... \u2819 | scratch'
    const next = '\u2839 renaming... \u2839 | scratch'
    expect(getDecorativeTitleGateKey(next, next)).toBe(getDecorativeTitleGateKey(first, first))
  })

  it('keeps braille inside a title that is not a copy of the leading frame', () => {
    expect(
      isDecorativeAgentTitleFrameChange('\u280b Codex \u2801 task', '\u280b Codex \u2803 task')
    ).toBe(false)
    expect(
      isDecorativeAgentTitleFrameChange(
        '\u2819 renaming\u2819... | scratch',
        '\u2839 renaming\u2839... | scratch'
      )
    ).toBe(false)
  })

  it('accepts the scan limit and returns null for longer decorative titles', () => {
    const prefix = `${BRAILLE_SPINNER_FRAME_A} Codex is thinking `
    const tail = 'x'.repeat(DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT - prefix.length)
    const title = `${prefix}${tail}`

    expect(getDecorativeAgentTitleSignature(title)).toBe(`working:Codex is thinking ${tail}`)
    expect(getDecorativeAgentTitleSignature(`${title}x`)).toBeNull()
  })
})
