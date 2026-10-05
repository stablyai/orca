import { describe, expect, it } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

describe('reference definition eligibility at actual parser boundaries', () => {
  it.each([
    ['small', '\ufeff[id]: /x\n'],
    ['large', `\ufeff[id]: /x\n\n${'x'.repeat(50_001)}`]
  ])(
    'keeps a real definition blocked after a UTF-8 byte order mark in a %s document',
    (_size, content) => {
      expect(getMarkdownRichModeUnsupportedReason(content)).toBe('reference-links')
    }
  )

  it.each(['[id]: `/x`\n', '[`id`]: /x\n', '[a\\]b]: /x\n', '[a\nb]: /x\n'])(
    'keeps a real definition blocked without stripping its label or destination: %s',
    (content) => {
      expect(getMarkdownRichModeUnsupportedReason(content)).toBe('reference-links')
    }
  )

  it.each(['    [id]: /x\n', '```\n[id]: /x\n```\n', '`[id]: /x`\n'])(
    'allows reference-looking code according to its original block context: %s',
    (content) => {
      expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
    }
  )

  it('keeps large fenced examples eligible without starting a parser', () => {
    const content = `\`\`\`md\n${'x'.repeat(50_001)}\n[id]: /x\n\`\`\`\n`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
  })

  it('keeps large definitions with an escaped closing bracket blocked', () => {
    const content = `[a\\]b]: /x\n\n${'x'.repeat(50_001)}`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('reference-links')
  })

  it('keeps repeated unclosed labels in a large document eligible', () => {
    expect(getMarkdownRichModeUnsupportedReason('[\n'.repeat(32_000))).toBeNull()
  })

  it('keeps ordinary label prose eligible beside a code example', () => {
    const content = '```md\n[id]: /x\n```\n\n[Bug]: text with spaces\n'
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
  })

  it.each(['[Plain label]', '[Link](https://example.com)'])(
    'does not add a large-document fallback for ordinary bracket text: %s',
    (tail) => {
      expect(getMarkdownRichModeUnsupportedReason(`${'x'.repeat(50_001)}\n${tail}\n`)).toBeNull()
    }
  )
})
