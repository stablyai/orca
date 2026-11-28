import { describe, expect, it } from 'vitest'
import { classifyNativeChatMarkdown } from './native-chat-composer-markdown-syntax'

const kinds = (lines: string[]) => classifyNativeChatMarkdown(lines).map((line) => line.block)
const styled = (line: string, kind: string) =>
  classifyNativeChatMarkdown([line])[0]
    .spans.filter((s) => s.kind === kind)
    .map((s) => line.slice(s.from, s.to))

describe('classifyNativeChatMarkdown', () => {
  it('finds each block the chat renders', () => {
    expect(kinds(['# h', '> q', '- a', '1. b', '***', 'plain'])).toEqual([
      { kind: 'heading', level: 1 },
      { kind: 'quote' },
      { kind: 'bullet' },
      { kind: 'ordered' },
      { kind: 'rule' },
      { kind: 'text' }
    ])
  })

  it('keeps text inside a fence as code until it closes, or to the end', () => {
    expect(kinds(['```ts', '# not a heading', '```', '# heading']).map((b) => b.kind)).toEqual([
      'fence',
      'code',
      'fence',
      'heading'
    ])
    expect(kinds(['~~~', '- x']).map((b) => b.kind)).toEqual(['fence', 'code'])
  })

  it('keeps spaced dashes a rule under text, and a fence open past a pill-shaped tail', () => {
    expect(kinds(['text', '- - -']).map((b) => b.kind)).toEqual(['text', 'rule'])
    expect(kinds(['```', '``` \uFFFC', '# raw']).map((b) => b.kind)).toEqual([
      'fence',
      'code',
      'code'
    ])
  })

  it('does not treat a hash without a space, or a dash under text, as a heading or rule', () => {
    expect(kinds(['#tag', 'title', '---']).map((b) => b.kind)).toEqual(['text', 'text', 'text'])
  })

  it('styles nested emphasis and leaves code and escapes alone', () => {
    expect(styled('a **b *c* d** e', 'bold')).toEqual(['b *c* d'])
    expect(styled('a **b *c* d** e', 'italic')).toEqual(['c'])
    expect(styled('`**no**` and \\*no\\*', 'bold')).toEqual([])
    expect(styled('`**no**` and \\*no\\*', 'italic')).toEqual([])
    expect(styled('snake_case_name and 2 * 3 * 4', 'italic')).toEqual([])
    expect(styled('a ~~gone~~', 'strike')).toEqual(['gone'])
    expect(styled('foo__bar__baz and foo___bar___baz', 'bold')).toEqual([])
    expect(styled('__bar__ and ___baz___', 'bold')).toEqual(['baz', 'bar'])
    expect(styled('`C:\\` and **bold** and `x`', 'bold')).toEqual(['bold'])
    expect(styled('`C:\\` and **bold** and `x`', 'code')).toEqual(['C:\\', 'x'])
  })
})
