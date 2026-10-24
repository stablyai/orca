import { describe, expect, it } from 'vitest'
import {
  DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT,
  getDecorativeAgentTitleSignature,
  isDecorativeAgentTitleFrameChange
} from './agent-decorative-title-signature'

const BRAILLE_SPINNER_FRAME_A = String.fromCharCode(0x280b)
const BRAILLE_SPINNER_FRAME_B = String.fromCharCode(0x2819)

describe('agent decorative title signatures', () => {
  it('treats spinner-only frame changes as the same decorative title', () => {
    expect(
      isDecorativeAgentTitleFrameChange(
        `${BRAILLE_SPINNER_FRAME_A} Codex is thinking`,
        `${BRAILLE_SPINNER_FRAME_B}  Codex\tis\nthinking`
      )
    ).toBe(true)
  })

  it('returns null for ordinary non-agent titles', () => {
    expect(getDecorativeAgentTitleSignature('vim src/index.ts')).toBeNull()
  })

  it('folds title whitespace in the decorative signature', () => {
    const title = ` \t${BRAILLE_SPINNER_FRAME_A}\t Codex   is\nthinking ${' pasted text '.repeat(40)}`

    expect(getDecorativeAgentTitleSignature(title)).toBe(
      `working:Codex is thinking ${'pasted text '.repeat(40).trimEnd()}`
    )
  })

  it('accepts the scan limit and returns null for longer decorative titles', () => {
    const prefix = `${BRAILLE_SPINNER_FRAME_A} Codex is thinking `
    const tail = 'x'.repeat(DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT - prefix.length)
    const title = `${prefix}${tail}`

    expect(getDecorativeAgentTitleSignature(title)).toBe(`working:Codex is thinking ${tail}`)
    expect(getDecorativeAgentTitleSignature(`${title}x`)).toBeNull()
  })
})
