import { describe, expect, it } from 'vitest'
import {
  appendAgentLaunchDraft,
  buildContainedLinkedContextBlock,
  LINKED_CONTEXT_BLOCK_MAX_CHARS
} from './linked-work-item-context'

describe('contained linked context block', () => {
  it('escapes terminal and unicode format controls from linked context source data', () => {
    const tagLatinSmallLetterA = String.fromCodePoint(0xe0061)
    const block = buildContainedLinkedContextBlock({
      provider: 'linear',
      version: 1,
      renderedText: `before\u001b[201~after\u0007\tindent\u202Ehidden\u200Btag${tagLatinSmallLetterA}\u00AD\u180E\uFFF9`
    })

    expect(block).toContain('before\\x1B[201~after\\x07  indent\\x202Ehidden\\x200Btag\\xE0061')
    expect(block).toContain('\\xAD\\x180E\\xFFF9')
    expect(block).not.toContain('\u001b[201~')
    expect(block).not.toContain('\u0007')
    expect(block).not.toContain('\u202E')
    expect(block).not.toContain('\u200B')
    expect(block).not.toContain('\u00AD')
    expect(block).not.toContain('\u180E')
    expect(block).not.toContain('\uFFF9')
    expect(block).not.toContain(tagLatinSmallLetterA)
  })

  it('caps contained context source data', () => {
    const block = buildContainedLinkedContextBlock({
      provider: 'linear',
      version: 1,
      renderedText: Array.from({ length: 2000 }, (_, index) => `line-${index}`).join('\n')
    })

    expect(block?.length).toBeLessThanOrEqual(LINKED_CONTEXT_BLOCK_MAX_CHARS)
    expect(block).toContain('[linked context truncated]')
    expect(block?.endsWith('--- END LINKED WORK ITEM CONTEXT ---')).toBe(true)
  })
})

describe('appendAgentLaunchDraft', () => {
  it('leaves the linked draft alone without an agent draft', () => {
    expect(appendAgentLaunchDraft('note\n\nhttps://example.com/1', '   ')).toBe(
      'note\n\nhttps://example.com/1'
    )
    expect(appendAgentLaunchDraft(null, undefined)).toBeNull()
  })

  it('drafts the agent prompt alone or after the linked draft', () => {
    expect(appendAgentLaunchDraft(null, '  Implement the plan.  ')).toBe('Implement the plan.\n')
    expect(appendAgentLaunchDraft('note\n\nhttps://example.com/1\n', 'Implement the plan.')).toBe(
      'note\n\nhttps://example.com/1\n\nImplement the plan.\n'
    )
  })
})
