import { describe, expect, it } from 'vitest'
import { withQuoteInserted } from './native-chat-selection-quote-draft'

// A quote starts a line and adds no empty line; the empty lines that the user typed stay.
describe('withQuoteInserted', () => {
  it.each([
    ['', '> q\n\n'],
    ['typed', 'typed\n> q\n\n'],
    ['typed\n', 'typed\n> q\n\n'],
    ['typed\n\n\n', 'typed\n\n\n> q\n\n'],
    // Markdown continues a blockquote directly above into the quote: a blank line keeps them apart.
    ['> old', '> old\n\n> q\n\n'],
    ['> old\nlazy', '> old\nlazy\n\n> q\n\n'],
    ['> old\n\ntext', '> old\n\ntext\n> q\n\n']
  ])('adds the quote at the end of %j', (draft, text) => {
    expect(withQuoteInserted(draft, '> q\n\n')).toEqual({ text, caret: text.length })
  })
})
