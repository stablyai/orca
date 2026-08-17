import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

function rendered(content: string, disableLinkDefinitions: boolean): string {
  return renderToStaticMarkup(
    <CommentMarkdown
      variant="document"
      content={content}
      disableLinkDefinitions={disableLinkDefinitions}
    />
  )
    .replace(/<[^>]*>/g, '')
    .trim()
}

describe('disableLinkDefinitions', () => {
  // Each of these renders to nothing at all without the opt-in — the user's
  // whole line disappears, which is the defect, not a formatting nicety.
  it.each([
    ['at the top level', '[Image #1]: /tmp/a.png', '[Image #1]: /tmp/a.png'],
    ['inside a bullet', '- [Image #1]: /tmp/a.png', '[Image #1]: /tmp/a.png'],
    ['inside an ordered item', '1. [Image #1]: /tmp/a.png', '[Image #1]: /tmp/a.png'],
    ['inside a blockquote', '> [Image #1]: /tmp/a.png', '[Image #1]: /tmp/a.png'],
    // GFM adds a second definition construct that swallows prose the same way.
    [
      'as a footnote definition',
      '[^note]: I meant this literally',
      '[^note]: I meant this literally'
    ],
    // A link label may span lines, so the swallow is not a single-line shape.
    [
      'with a wrapped label',
      '[Image #1\nstill mine]: /tmp/a.png',
      '[Image #1\nstill mine]: /tmp/a.png'
    ]
  ])('keeps a definition-shaped line %s', (_name, typed, expected) => {
    expect(rendered(typed, false)).toBe('')
    expect(rendered(typed, true)).toBe(expected)
  })

  it('keeps the sibling content a swallowed definition took with it', () => {
    const typed = '- [Image #1]: /tmp/a.png\n- second'

    expect(rendered(typed, false)).toBe('second')
    expect(rendered(typed, true)).toBe('[Image #1]: /tmp/a.png\nsecond')
  })

  it.each([
    'keep [Image #1] literal',
    'plain prose with a colon: like this',
    'see [the docs](https://example.com) here',
    'see [the docs][d] here',
    '```\n[Image #1]: /tmp/a.png\n```',
    '~~~\ncode\n```\n[Image #1]: /tmp/a.png\n~~~',
    '| a | b |\n| - | - |\n| 1 | 2 |'
  ])('leaves content the pipeline already rendered untouched', (typed) => {
    // Why the second assertion: comparing the two prop values to each other is
    // trivially true if the plugin ever stops attaching, so pin that these
    // render something before trusting that they render the same thing.
    expect(rendered(typed, true)).not.toBe('')
    expect(rendered(typed, true)).toBe(rendered(typed, false))
  })

  // The one intended difference: an authored definition stops being consumed,
  // so its reference renders literally rather than as a resolved link.
  it('renders an authored definition as the text it is', () => {
    const typed = '[d]: https://example.com\n\nsee [the docs][d] here'

    expect(rendered(typed, false)).toBe('see the docs here')
    expect(rendered(typed, true)).toBe('[d]: https://example.com\nsee [the docs][d] here')
  })
})
