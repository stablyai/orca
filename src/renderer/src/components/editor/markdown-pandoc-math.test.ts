import { describe, expect, it } from 'vitest'
import {
  blockMathStartIndex,
  findPandocMathSpans,
  matchPandocBlockMath,
  matchPandocInlineMath,
  protectNonMathDollars
} from './markdown-pandoc-math'

describe('matchPandocInlineMath', () => {
  it.each([
    ['$x$', 'x'],
    ['$E=mc^2$', 'E=mc^2'],
    ['$E = mc^2$', 'E = mc^2'],
    ['$x_1$', 'x_1'],
    ['$\\frac{1}{2}$', '\\frac{1}{2}'],
    ['$a +\nb$', 'a +\nb'],
    ['$x\\\\$', 'x\\\\'],
    ['$a *b* c$', 'a *b* c']
  ])('accepts %j', (src, latex) => {
    expect(matchPandocInlineMath(src)).toEqual({ raw: src, latex })
  })

  it.each([
    '$1,200',
    'at $0',
    '$ x$',
    '$x $',
    '$100 and $200',
    '$x$2',
    '$$x$$',
    '\\$x$',
    '$foo{bar$'
  ])('rejects %j', (src) => {
    expect(matchPandocInlineMath(src)).toBeUndefined()
  })

  it('matches the Pandoc $5-$x hole as $5-$', () => {
    expect(matchPandocInlineMath('$5-$x')).toEqual({ raw: '$5-$', latex: '5-' })
  })
})

describe('findPandocMathSpans', () => {
  it('finds $b$ in $a $b$', () => {
    expect(findPandocMathSpans('$a $b$')).toEqual([
      { kind: 'inline', start: 3, end: 6, latex: 'b' }
    ])
  })

  it('finds two adjacent spans in $a$$b$', () => {
    expect(findPandocMathSpans('$a$$b$')).toEqual([
      { kind: 'inline', start: 0, end: 3, latex: 'a' },
      { kind: 'inline', start: 3, end: 6, latex: 'b' }
    ])
  })

  it('finds the later valid pair after a KaTeX failure', () => {
    expect(findPandocMathSpans('$foo{bar$ and $x$')).toEqual([
      { kind: 'inline', start: 14, end: 17, latex: 'x' }
    ])
  })

  it('does not treat an escaped opener as math', () => {
    expect(findPandocMathSpans('\\$x$')).toEqual([])
    expect(findPandocMathSpans('\\$x\\$')).toEqual([])
  })

  it('does not find math in money or unclosed display delimiters', () => {
    expect(findPandocMathSpans('costs $$ big $$ here')).toEqual([])
    expect(findPandocMathSpans('text\n$$\nmore')).toEqual([])
  })
})

describe('matchPandocBlockMath', () => {
  it.each(['$$\nx\n$$', '  $$\nx\n$$', '$$\n\\$5 + x\n$$'])('accepts %j', (src) => {
    expect(matchPandocBlockMath(src)?.latex).toBe(src.includes('\\$5') ? '\\$5 + x' : 'x')
  })

  it.each(['costs $$ big $$ here', '$$\nmore', '$$$$'])('rejects %j', (src) => {
    expect(matchPandocBlockMath(src)).toBeUndefined()
  })

  it('does not treat an escaped $$ as the block closer', () => {
    expect(matchPandocBlockMath('$$\nx \\$$\nmore\n$$')).toEqual({
      raw: '$$\nx \\$$\nmore\n$$',
      latex: 'x \\$$\nmore'
    })
  })
})

describe('blockMathStartIndex', () => {
  it('does not split a mid-line $$', () => {
    expect(blockMathStartIndex('costs $$ big')).toBe(-1)
  })

  it('points at the newline before a closed display block in marked slice(1) input', () => {
    expect(blockMathStartIndex('ello\n$$\nx\n$$')).toBe('ello'.length)
  })

  it('ignores a line-start $$ with no closer', () => {
    expect(blockMathStartIndex('ext\n$$\nmore')).toBe(-1)
  })
})

describe('protectNonMathDollars', () => {
  it('escapes money dollars', () => {
    const protectedSource = protectNonMathDollars('$10 to $20')
    expect(protectedSource).toContain('\\$10')
    expect(protectedSource).toContain('\\$20')
  })

  it('leaves real inline math unchanged', () => {
    expect(protectNonMathDollars('$x$')).toBe('$x$')
  })

  it('escapes a closer followed by a digit', () => {
    expect(protectNonMathDollars('$x$2')).toBe('\\$x\\$2')
  })

  it('escapes the invalid opener in $a $b$', () => {
    expect(protectNonMathDollars('$a $b$')).toBe('\\$a $b$')
  })

  it('does not double-escape an already-escaped opener', () => {
    expect(protectNonMathDollars('\\$x$')).toBe('\\$x\\$')
  })

  it('leaves inline-code dollars unchanged', () => {
    expect(protectNonMathDollars('`$x$`')).toBe('`$x$`')
  })

  it('leaves fenced-code dollars unchanged', () => {
    expect(protectNonMathDollars('\n```\n$x$\n```\n')).toBe('\n```\n$x$\n```\n')
  })

  it('escapes mid-line display-looking dollars', () => {
    expect(protectNonMathDollars('costs $$ big $$ here')).toBe('costs \\$\\$ big \\$\\$ here')
  })

  it('leaves a real display block unchanged', () => {
    expect(protectNonMathDollars('$$\nx\n$$')).toBe('$$\nx\n$$')
  })

  it('leaves dollars inside a blockquote fence with a longer closer', () => {
    expect(protectNonMathDollars('> ```\n> $5\n> ````\n')).toBe('> ```\n> $5\n> ````\n')
  })

  it('leaves dollars inside a list fence with a longer closer', () => {
    expect(protectNonMathDollars('- ```\n  $5\n  ````\n')).toBe('- ```\n  $5\n  ````\n')
  })

  it('does not treat backtick runs split by a blank line as a code span', () => {
    const protectedSource = protectNonMathDollars('`unclosed\n\n$10 to $20')
    expect(protectedSource).toContain('\\$10')
    expect(protectedSource).toContain('\\$20')
  })
})
