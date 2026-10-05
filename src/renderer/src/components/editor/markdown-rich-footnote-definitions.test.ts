import { describe, expect, it } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

describe('footnote definitions retain Source eligibility', () => {
  it.each([
    ['byte order mark', '\ufeff[^id]: note\n\nUses [^id].\n'],
    ['no separator space', '[^id]:note\n\nUses [^id].\n'],
    ['quote', '> [^id]: note\n\nUses [^id].\n'],
    ['list', '- [^id]: note\n\nUses [^id].\n'],
    ['nested containers', '> 1. > [^id]: note\n\nUses [^id].\n'],
    ['escaped closing bracket', '[^a\\]b]: note\n\nUses [^a\\]b].\n'],
    ['backtick label', '[^`id`]: note\n\nUses [^`id`].\n']
  ])('blocks a valid definition in a %s context', (_name, content) => {
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('footnotes')
  })

  it.each([
    '    [^id]: note\n',
    '```md\n[^id]: note\n```\n',
    '`[^id]: note`\n',
    '> ```md\n> [^id]: note\n> ```\n',
    '[^id] is ordinary text.\n',
    '[^id with spaces]: ordinary text with spaces\n',
    '[^]: ordinary text with spaces\n'
  ])('keeps literal or code-only footnote text eligible: %s', (content) => {
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
  })

  it('retains reference definition precedence when both definitions occur', () => {
    expect(getMarkdownRichModeUnsupportedReason('[^id]: note\n\n[link]: /x\n')).toBe(
      'reference-links'
    )
  })

  it.each(['[^id with spaces]: /x\n', '[^]: /x\n'])(
    'keeps caret labels blocked when they are valid reference definitions: %s',
    (content) => {
      expect(getMarkdownRichModeUnsupportedReason(content)).toBe('reference-links')
    }
  )

  it.each(['\ufeff[^id]: note', '> [^id]: note', '[^id]:note'])(
    'retains conservative detection above the parser bound: %s',
    (definition) => {
      expect(
        getMarkdownRichModeUnsupportedReason(`${definition}\n\n${'x'.repeat(50_001)}`)
      ).not.toBeNull()
    }
  )
})
