// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { linkedSelectionText, withPastedLinks } from './native-chat-pasted-links'

describe('withPastedLinks', () => {
  it('keeps rich-text links as Markdown around the plain text', () => {
    const html =
      '<meta charset="utf-8"><p>Hey can you take a look at <a href="https://github.com/stablyai/orca/issues/39150">this\n  FR</a> and <a href="https://example.com/a(b)">[the] docs</a>?</p>'
    expect(withPastedLinks('Hey can you take a look at this FR and [the] docs?', html)).toBe(
      'Hey can you take a look at [this FR](https://github.com/stablyai/orca/issues/39150) and [\\[the\\] docs](https://example.com/a%28b%29)?'
    )
  })

  it('leaves bare URLs, unsafe schemes and existing Markdown alone', () => {
    const html =
      '<a href="https://example.com/">https://example.com/</a> <a href="javascript:alert(1)">run</a> <a href="https://x.dev">x</a>'
    const text = 'https://example.com/ run [x](https://x.dev)'
    expect(withPastedLinks(text, html)).toBe(text)
  })
})

describe('linkedSelectionText', () => {
  it('links the selected words to a pasted URL', () => {
    expect(linkedSelectionText('external links', ' https://example.com\n')).toBe(
      '[external links](https://example.com)'
    )
  })

  it('replaces instead when the selection or paste is not a word-to-URL pair', () => {
    expect(linkedSelectionText('https://old.dev', 'https://new.dev')).toBeNull()
    expect(linkedSelectionText('two\nlines', 'https://new.dev')).toBeNull()
    expect(linkedSelectionText('words', 'see https://new.dev')).toBeNull()
  })
})
