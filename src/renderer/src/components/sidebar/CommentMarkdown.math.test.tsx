import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

describe('CommentMarkdown math rendering', () => {
  it('renders inline math only when explicitly enabled', () => {
    const content = 'Inline $E = mc^2$'
    const disabledMarkup = renderToStaticMarkup(<CommentMarkdown content={content} />)
    const enabledMarkup = renderToStaticMarkup(<CommentMarkdown content={content} enableMath />)

    expect(disabledMarkup).toContain('$E = mc^2$')
    expect(disabledMarkup).not.toContain('class="katex"')
    expect(enabledMarkup).toContain('class="katex"')
    expect(enabledMarkup).toContain('<math')
  })

  it('renders multiline dollar and math-fenced expressions as display math', () => {
    const dollarMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'$$\n\\int_0^1 x^2 \\, dx\n$$'} enableMath />
    )
    const fencedMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'```math\n\\frac{a}{b}\n```'} enableMath />
    )

    expect(dollarMarkup).toContain('class="katex-display"')
    expect(fencedMarkup).toContain('class="katex-display"')
    expect(fencedMarkup).not.toContain('<pre')
  })

  it('normalizes GitHub backtick-delimited inline math', () => {
    const content = 'Inline $`\\sqrt{x}`$'
    const markup = renderToStaticMarkup(<CommentMarkdown content={content} enableMath />)

    expect(markup).toContain('<msqrt>')
    expect(markup).not.toContain('katex-error')
  })

  it('keeps inline code, escaped dollars, and incomplete streaming delimiters literal', () => {
    const content = '`$E = mc^2$` and \\$100 and $unfinished'
    const markup = renderToStaticMarkup(<CommentMarkdown content={content} enableMath />)

    expect(markup).not.toContain('class="katex"')
    expect(markup).toContain('$E = mc^2$')
    expect(markup).toContain('$100')
    expect(markup).toContain('$unfinished')
  })

  it('keeps invalid formulas visible instead of throwing or blanking them', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content={'$\\notARealCommand{x}$'} enableMath />
    )

    expect(markup).toContain('class="katex"')
    expect(markup).toContain('\\notARealCommand{x}')
  })
})
