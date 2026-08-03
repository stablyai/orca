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

  it('restores paired currency prose without changing Markdown code constructs', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content="Budget changed from $20 to $30." enableMath />
    )
    const inlineCodeMarkup = renderToStaticMarkup(
      <CommentMarkdown content="The source is `$20 to $30`." enableMath />
    )
    const unmatchedBacktickMarkup = renderToStaticMarkup(
      <CommentMarkdown content="Budget changed from $20 to $30. `" enableMath />
    )
    const unequalBacktickRunsMarkup = renderToStaticMarkup(
      <CommentMarkdown content="`a ``` b` and $20 to $30." enableMath />
    )
    const multilineCodeMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'`prices\n$20 to $30\n`'} enableMath />
    )
    const escapedBacktickMarkup = renderToStaticMarkup(
      <CommentMarkdown content="\`Budget changed from $20 to $30. `" enableMath />
    )
    const indentedParagraphMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'Budget:\n    from $20 to $30.'} enableMath />
    )
    const invalidFenceMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'```text`\nBudget changed from $20 to $30.'} enableMath />
    )
    const lineWrappedCurrencyMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'Budget changed from $20\nto $30.'} enableMath />
    )
    const numericMathMarkup = renderToStaticMarkup(
      <CommentMarkdown content="Value $20x$30" enableMath />
    )

    expect(markup).not.toContain('class="katex"')
    expect(markup).toContain('Budget changed from $20 to $30.')
    expect(inlineCodeMarkup).not.toContain('class="katex"')
    expect(inlineCodeMarkup).toContain('$20 to $30')
    expect(inlineCodeMarkup).not.toContain('\\$20')
    expect(unmatchedBacktickMarkup).not.toContain('class="katex"')
    expect(unequalBacktickRunsMarkup).not.toContain('class="katex"')
    expect(multilineCodeMarkup).not.toContain('class="katex"')
    expect(multilineCodeMarkup).not.toContain('\\$20')
    expect(escapedBacktickMarkup).not.toContain('class="katex"')
    expect(indentedParagraphMarkup).not.toContain('class="katex"')
    expect(invalidFenceMarkup).not.toContain('class="katex"')
    expect(lineWrappedCurrencyMarkup).not.toContain('class="katex"')
    expect(lineWrappedCurrencyMarkup).toContain('<br')
    expect(numericMathMarkup).toContain('class="katex"')
  })

  it('recovers bare and TeX bracket-delimited display math without capturing prose or code fences', () => {
    const formulaMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'[\nS(x)=\\min_i \\frac{x_i^2}{r_i}\n]'} enableMath />
    )
    const latexDelimitedMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'\\[\nS(x)=\\min_i \\frac{x_i^2}{r_i}\n\\]'} enableMath />
    )
    const sameLineTexMarkup = renderToStaticMarkup(<CommentMarkdown content="\[x=1\]" enableMath />)
    const proseMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'[\nplain bracketed prose\n]'} enableMath />
    )
    const fencedMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'```\n[\nx=1\n]\n```'} enableMath />
    )
    const invalidFenceMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'```text\n```not-a-close\n[\nx=1\n]\n```'} enableMath />
    )
    const indentedCodeMarkup = renderToStaticMarkup(
      <CommentMarkdown content={'    [\n    x=1\n    ]'} enableMath />
    )

    expect(formulaMarkup).toContain('class="katex-display"')
    expect(formulaMarkup).toContain('<msub>')
    expect(latexDelimitedMarkup).toContain('class="katex-display"')
    expect(latexDelimitedMarkup).toContain('<msub>')
    expect(sameLineTexMarkup).toContain('class="katex-display"')
    expect(proseMarkup).not.toContain('class="katex"')
    expect(proseMarkup).toContain('plain bracketed prose')
    expect(fencedMarkup).not.toContain('class="katex"')
    expect(fencedMarkup).toContain('x=1')
    expect(invalidFenceMarkup).not.toContain('class="katex"')
    expect(invalidFenceMarkup).toContain('x=1')
    expect(indentedCodeMarkup).not.toContain('class="katex"')
    expect(indentedCodeMarkup).toContain('x=1')
  })

  it('renders stripped bracket-delimited aligned environments as display math', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        content={
          '[\n\\begin{aligned}\n\\mathcal A_T &= \\left\\{x:S(x)\\le T\\right\\} \\\\\nS(x) &= \\min_i \\frac{\\left\\lVert z(x)-z_i\\right\\rVert_2^2}{r_i}\n\\end{aligned}\n]'
        }
        enableMath
      />
    )

    expect(markup).toContain('class="katex-display"')
    expect(markup).not.toContain('katex-error')
  })

  it('keeps invalid formulas visible instead of throwing or blanking them', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content={'$\\notARealCommand{x}$'} enableMath />
    )

    expect(markup).toContain('class="katex"')
    expect(markup).toContain('\\notARealCommand{x}')
  })
})
