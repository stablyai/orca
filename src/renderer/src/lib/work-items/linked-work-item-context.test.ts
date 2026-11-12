import { describe, expect, it } from 'vitest'
import {
  buildContainedLinkedContextBlock,
  resolveQuickCreateLinkedWorkItemPrompt
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
})

describe('quick create initial prompt', () => {
  it('auto-submits a multiline prompt verbatim when no work item is linked', () => {
    expect(
      resolveQuickCreateLinkedWorkItemPrompt(null, '', '  Fix login\nAdd a regression test.\n')
    ).toEqual({
      prompt: '  Fix login\nAdd a regression test.\n',
      draftPrompt: null
    })
  })

  it('sends only the explicitly entered prompt when a work item is linked', () => {
    expect(
      resolveQuickCreateLinkedWorkItemPrompt(
        { number: 42, url: 'https://github.com/acme/app/issues/42' },
        '',
        'Fix this issue'
      )
    ).toEqual({
      prompt: 'Fix this issue',
      draftPrompt: null
    })
  })
})
