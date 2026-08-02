import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT,
  getDecorativeAgentTitleSignature,
  isDecorativeAgentTitleFrameChange
} from './agent-decorative-title-signature'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('folds title whitespace without full whitespace replacement', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const title = ` \t${BRAILLE_SPINNER_FRAME_A}\t Codex   is\nthinking ${' pasted text '.repeat(40)}`

    expect(getDecorativeAgentTitleSignature(title)).toBe(
      `working:Codex is thinking ${'pasted text '.repeat(40).trimEnd()}`
    )
    expect(
      replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })

  it('does not normalize oversized title text on the hot path', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const title = `${BRAILLE_SPINNER_FRAME_A} Codex is thinking ${'x'.repeat(
      DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT + 1
    )}`

    expect(getDecorativeAgentTitleSignature(title)).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })
})
