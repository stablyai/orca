// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import { NativeChatMarkdown } from '../native-chat/NativeChatMarkdown'

vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))
afterEach(cleanup)

function documentOf(
  content: string,
  props: { math?: boolean; fadeWords?: boolean } = {}
): HTMLElement {
  const node = document.createElement('div')
  node.innerHTML = renderToStaticMarkup(<CommentMarkdown content={content} math {...props} />)
  return node
}

function annotations(node: HTMLElement): string[] {
  return Array.from(node.querySelectorAll('annotation'), (element) => element.textContent ?? '')
}

describe('native chat math', () => {
  it('centers standalone raw double dollars while keeping prose and converted variables inline', () => {
    const source = String.raw`The proxy is:
$$V\approx\frac{a}{b}$$
Explanation with $e_t$, \(x_i\), and prose $$y^2$$.
$$\sum_{i=1}^{n}\frac{c_i^2}{i}$$`
    const node = documentOf(source)
    expect(annotations(node)).toEqual([
      String.raw`V\approx\frac{a}{b}`,
      'e_t',
      'x_i',
      'y^2',
      String.raw`\sum_{i=1}^{n}\frac{c_i^2}{i}`
    ])
    expect(node.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(node.querySelectorAll('math[display="block"]')).toHaveLength(2)
    expect(node.querySelector('.katex-display .large-op')).not.toBeNull()
    const inline = Array.from(node.querySelectorAll('annotation')).filter((element) =>
      ['e_t', 'x_i', 'y^2'].includes(element.textContent ?? '')
    )
    expect(inline.every((element) => !element.closest('.katex-display'))).toBe(true)
    expect(documentOf(source, { math: false }).querySelector('.katex')).toBeNull()
    const native = document.createElement('div')
    native.innerHTML = renderToStaticMarkup(<NativeChatMarkdown content="$e_t$" />)
    expect(annotations(native)).toEqual(['e_t'])
  })

  it('supports multiline math and TeX blocks without changing Markdown containers', () => {
    const source = [
      String.raw`\[\begin{pmatrix}a&b\\c&d\end{pmatrix}\]`,
      '',
      '$$',
      'x^2 +',
      '',
      'y^2',
      '$$',
      '',
      '> $$q$$',
      '',
      '- $$r$$',
      '',
      '$e_t$',
      '',
      String.raw`\(z_i\)`,
      '',
      '$$$s$$$'
    ].join('\n')
    const node = documentOf(source)
    expect(node.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(node.querySelector('blockquote .katex-display')).toBeNull()
    expect(node.querySelector('li .katex-display')).toBeNull()
    expect(node.querySelectorAll('.katex-error')).toHaveLength(0)
    expect(annotations(node)).toContain('e_t')
    expect(annotations(node)).toContain('z_i')
  })

  it('protects prices, code, links, escaped delimiters and unfinished input', () => {
    const source = [
      'Prices $10 and $20; 中文 $10和$20，变量 $e_t$，$10和$x$。',
      '`$code$` and `$$code$$`',
      '[link $label$](https://example.com/$path$)',
      '```latex',
      '$$x$$',
      String.raw`\[x\]`,
      '```',
      String.raw`\$escaped\$ and \\(escaped\\)`,
      '$unclosed',
      '$$unclosed',
      String.raw`\(unclosed`
    ].join('\n\n')
    const node = documentOf(source)
    expect(annotations(node)).toEqual(['e_t', 'x'])
    expect(node.textContent).toContain('$10和$20')
    expect(node.textContent).toContain('$10和')
    expect(node.querySelector('a')?.textContent).toBe('link $label$')
    expect(node.querySelector('pre')?.textContent).toContain('$$x$$')
    expect(node.querySelectorAll('.katex-display')).toHaveLength(0)
  })

  it('keeps untrusted math and HTML from creating executable content', () => {
    const node = documentOf(
      String.raw`$\href{javascript:alert(1)}{bad}$ $\htmlClass{injected}{x}$ <script>alert(1)</script><img src="x" onerror="alert(1)">`
    )
    expect(node.querySelector('script,[onerror],.injected')).toBeNull()
    expect(node.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(node.querySelectorAll('.katex')).toHaveLength(2)
  })

  it('fades prose without wrapping KaTeX internals', () => {
    const node = documentOf('New words $e_t$ and more words.', { fadeWords: true })
    expect(node.querySelector('[data-word-group]')).not.toBeNull()
    expect(node.querySelector('.katex [data-word-group], .katex [data-word]')).toBeNull()
    expect(annotations(node)).toEqual(['e_t'])
  })

  it('renders streamed display formulas with blank lines exactly like finished content', () => {
    const source = [
      'The proxy:',
      '$$V=\\frac{a}{b}$$',
      'Explanation $e_t$.',
      '',
      '$$',
      '\\sum_i x_i +',
      '',
      'y_i',
      '$$',
      '',
      'Done.'
    ].join('\n')
    const whole = render(<CommentMarkdown content={source} math />)
    const blocks = (node: HTMLElement): string[] =>
      Array.from(node.firstElementChild?.children ?? [], (element) => element.outerHTML)
    const expected = blocks(whole.container)
    whole.unmount()
    const streamed = render(<CommentMarkdown content="" math growing />)
    for (let end = 1; end < source.length; end += 7) {
      streamed.rerender(<CommentMarkdown content={source.slice(0, end)} math growing />)
    }
    streamed.rerender(<CommentMarkdown content={source} math />)
    expect(blocks(streamed.container)).toEqual(expected)
    expect(streamed.container.querySelectorAll('.katex-display')).toHaveLength(2)
  })
})
