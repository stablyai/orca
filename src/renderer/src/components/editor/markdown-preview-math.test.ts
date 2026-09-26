import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import { protectNonMathDollars } from './markdown-pandoc-math'

function renderPreview(src: string): string {
  return renderToStaticMarkup(
    React.createElement(
      Markdown,
      { remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] },
      protectNonMathDollars(src)
    )
  )
}

function mathInlineCount(html: string): number {
  return html.split('class="katex"').length - 1
}

describe('markdown preview dollar math', () => {
  const money = '(deficit −$509,542 by end-2020), so stock basis entered 2021 at $0'

  it('keeps the STA-7375 sentence and $10 to $20 as text', () => {
    const sta = renderPreview(money)
    expect(sta).toContain('$509,542')
    expect(sta).toContain('$0')
    expect(sta).not.toContain('math-inline')
    expect(mathInlineCount(sta)).toBe(0)

    const range = renderPreview('$10 to $20')
    expect(range).toContain('$10')
    expect(range).toContain('$20')
    expect(range).not.toContain('math-inline')
    expect(mathInlineCount(range)).toBe(0)
  })

  it('typesets real inline math', () => {
    expect(mathInlineCount(renderPreview('$x$'))).toBe(1)
    expect(renderPreview('$x$')).toContain('katex')
    expect(mathInlineCount(renderPreview('$\\frac{1}{2}$'))).toBe(1)
  })

  it('does not typeset a closer followed by a digit', () => {
    const html = renderPreview('$x$2')
    expect(mathInlineCount(html)).toBe(0)
    expect(html).toContain('$x$2')
  })

  it('typesets the later pair in $a $b$ and $1 $x$', () => {
    expect(mathInlineCount(renderPreview('$a $b$'))).toBe(1)
    expect(mathInlineCount(renderPreview('$1 $x$'))).toBe(1)
  })

  it('typesets $a *b* c$ as one formula', () => {
    const html = renderPreview('$a *b* c$')
    expect(mathInlineCount(html)).toBe(1)
    expect(html).not.toContain('<em>')
  })

  it('pins the $a$$b$ residual as one preview formula', () => {
    const html = renderPreview('$a$$b$')
    // micromark coalesces adjacent $a$+$b$ into one formula `a$$b`; KaTeX errors on `$` in math.
    expect(html).toContain('katex-error')
    expect(html).toContain('a$$b')
    expect(mathInlineCount(html)).toBe(0)
  })

  it('keeps mid-line $$ as literal dollars', () => {
    const html = renderPreview('costs $$ big $$ here')
    expect(html).toContain('$$ big $$')
    expect(mathInlineCount(html)).toBe(0)
  })

  it('does not typeset an unclosed line-start $$ as display math', () => {
    const html = renderPreview('text\n$$\nmore')
    expect(html).not.toContain('math-display')
    expect(html).toContain('$$')
  })

  it('does not typeset an escaped opener', () => {
    const html = renderPreview('\\$x$')
    expect(mathInlineCount(html)).toBe(0)
    expect(html).toContain('$x$')
  })

  it('leaves dollars inside inline code', () => {
    const html = renderPreview('`$x$`')
    expect(html).toContain('<code>')
    expect(mathInlineCount(html)).toBe(0)
    expect(html).toContain('$x$')
  })

  it('leaves dollars inside a blockquote fence with a longer closer', () => {
    const html = renderPreview('> ```\n> $5\n> ````\n')
    expect(html).toContain('$5')
    expect(html).not.toContain('\\$5')
    expect(mathInlineCount(html)).toBe(0)
  })

  it('does not typeset money after an unclosed backtick and a blank line', () => {
    const html = renderPreview('`unclosed\n\n$10 to $20')
    expect(html).toContain('$10')
    expect(html).toContain('$20')
    expect(mathInlineCount(html)).toBe(0)
  })
})
