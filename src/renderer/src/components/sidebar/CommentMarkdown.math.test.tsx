// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Processor } from 'unified'
import type remarkParsePlugin from 'remark-parse'
import {
  readNativeChatQuotableSelection,
  readNativeChatTranscriptSelection
} from '../native-chat/native-chat-quote-selection'
import CommentMarkdown from './CommentMarkdown'
import { splitMarkdownTopLevelBlocks, type MarkdownBlockSplit } from './markdown-top-level-blocks'
import { NativeChatMarkdown } from '../native-chat/NativeChatMarkdown'

const parsing = vi.hoisted(() => ({ characters: 0, calls: 0 }))
vi.mock('remark-parse', async (original) => {
  const { default: remarkParse } = await original<{ default: typeof remarkParsePlugin }>()
  return {
    default: function (this: Processor) {
      remarkParse.call(this)
      const parser = this.parser
      if (parser) {
        this.parser = (source, file) => {
          parsing.characters += source.length
          parsing.calls++
          return parser(source, file)
        }
      }
    }
  }
})

vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))
afterEach(cleanup)

function documentOf(
  content: string,
  props: { math?: boolean; fadeWords?: boolean } = {}
): HTMLElement {
  const node = document.createElement('div')
  node.innerHTML = renderToStaticMarkup(
    <CommentMarkdown content={content} math variant="document" {...props} />
  )
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
    expect(node.querySelectorAll('.katex-display')).toHaveLength(5)
    expect(node.querySelector('blockquote .katex-display')).not.toBeNull()
    expect(node.querySelector('li .katex-display')).not.toBeNull()
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

  it.each([
    ['$$a +\nb$$', null, true],
    ['$$\na +\nb $$', null, true],
    ['$$a +\nb $$', null, true],
    ['$$a+b$$ after.', 'p', false],
    [String.raw`\[a+b\] after.`, 'p', false],
    [
      String.raw`Before \[a +
b\] after.`,
      'p',
      false
    ],
    [
      String.raw`\[a +
b\]`,
      null,
      true
    ],
    ['> $$a +\n>\n> b $$', 'blockquote', true],
    ['- $$a +\n\n  b $$', 'li', true],
    [
      String.raw`> \[a +
>
> b\]`,
      'blockquote',
      true
    ],
    [
      String.raw`- \[a +

  b\]`,
      'li',
      true
    ],
    [
      String.raw`| formula |
| - |
| \[a+b\] |`,
      'td',
      false
    ],
    [String.raw`## \[a+b\]`, 'h2', false],
    [String.raw`Prose \[a+b\] continues.`, 'p', false]
  ])('preserves fence text and container for %s', (source, container, display) => {
    const node = documentOf(source)
    expect(annotations(node).map((text) => text.replace(/\s/g, ''))).toEqual(['a+b'])
    expect(Boolean(node.querySelector('.katex-display'))).toBe(display)
    if (container) {
      expect(node.querySelector(`${container} .katex`)).not.toBeNull()
    }
  })

  it.each(['$$', String.raw`\[`])(
    'keeps unfinished %s source across blank lines until authored closure',
    (opener) => {
      const closer = opener === '$$' ? '$$' : String.raw`\]`
      const prefix = `Settled.\n\nEarlier.\n\n${opener}x +\n\ny +\n\nz`
      let split: MarkdownBlockSplit | null = null
      const streamed = render(<CommentMarkdown content="" math growing />)
      for (let end = 1; end <= prefix.length; end++) {
        const content = prefix.slice(0, end)
        split = splitMarkdownTopLevelBlocks(content, split, true)
        streamed.rerender(<CommentMarkdown content={content} math growing />)
        expect(streamed.container.querySelector('.katex')).toBeNull()
      }
      expect(split?.blocks.at(-1)?.text).toBe(`${opener}x +\n\ny +\n\nz`)
      expect(streamed.container.textContent).toContain(`${opener}x +\n\ny +\n\nz`)
      streamed.rerender(<CommentMarkdown content={prefix} math />)
      expect(streamed.container.textContent).toContain(`${opener}x +\n\ny +\n\nz`)
      streamed.rerender(<CommentMarkdown content={prefix + closer} math />)
      expect(annotations(streamed.container).map((text) => text.replace(/\s/g, ''))).toEqual([
        'x+y+z'
      ])
    }
  )

  it('keeps citations, partial inline formulas and invalid complete formulas readable', () => {
    for (const source of [
      String.raw`See \[1, 2\] for source.`,
      '$$x',
      '$$\nx',
      String.raw`\(x`,
      '$x'
    ]) {
      expect(documentOf(source).textContent).toBe(
        source.replaceAll('\\[', '[').replaceAll('\\]', ']')
      )
      expect(documentOf(source).querySelector('.katex')).toBeNull()
    }
    const invalid = documentOf(String.raw`$\notACommand{x}$`)
    expect(invalid.textContent).toBe(String.raw`$\notACommand{x}$`)
    expect(invalid.querySelector('.katex-error')).toBeNull()
    expect(documentOf('```math\nx^2\n```').querySelector('.katex')).not.toBeNull()
  })

  it('copies selected formulas as source once and keeps surrounding prose', () => {
    const source = 'Before $x^2$ after.'
    const rendered = render(<CommentMarkdown content={source} math variant="document" />)
    const transcript = rendered.container.firstElementChild
    transcript?.setAttribute('data-native-chat-scroll', '')
    transcript?.setAttribute('data-native-chat-quote-source', '')
    const paragraph = rendered.container.querySelector('p')
    if (!paragraph) {
      throw new Error('Missing paragraph')
    }
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    // Native DOM selection contains both the visual glyphs and its TeX annotation.
    expect(range.cloneContents().textContent).not.toBe(source)
    const setData = vi.fn()
    fireEvent.copy(paragraph, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', source)
    expect(readNativeChatQuotableSelection(rendered.container)?.text).toBe(source)
    expect(readNativeChatTranscriptSelection(rendered.container)).toBe(source)
    const glyph = paragraph.querySelector('.katex-html')
    if (!glyph) {
      throw new Error('Missing typeset formula')
    }
    range.selectNodeContents(glyph)
    selection?.removeAllRanges()
    selection?.addRange(range)
    setData.mockClear()
    fireEvent.copy(glyph, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', '$x^2$')
    expect(readNativeChatQuotableSelection(rendered.container)?.text).toBe('$x^2$')
    selection?.removeAllRanges()
  })

  it('bounds parser work on the actual growing renderer at N and 10N appended blocks', () => {
    function work(count: number): number {
      const streamed = render(<CommentMarkdown content="" math growing />)
      parsing.characters = 0
      let source = ''
      for (let index = 0; index < count; index++) {
        source += `Block ${index} $x^2$ with \`literal $price$\` and [link](https://example.com/$path$).\n\n`
        streamed.rerender(<CommentMarkdown content={source} math growing />)
      }
      const characters = parsing.characters
      streamed.unmount()
      return characters
    }
    const n = work(10)
    const tenN = work(100)
    process.stdout.write(`Streaming parsed characters, N=10: ${n}; N=100: ${tenN}\n`)
    expect(tenN).toBeLessThan(n * 12)
  })

  it('keeps code disclosure coordinates on the authored source after math', () => {
    const source = '$$a +\nb$$\n\n```ts\nconst value = 1\n```'
    const code = vi.fn(({ sourceLine }: { sourceLine?: number }) => (
      <pre data-source-line={sourceLine} />
    ))
    const streamed = render(
      <CommentMarkdown content="" math growing variant="document" renderCodeBlock={code} />
    )
    streamed.rerender(
      <CommentMarkdown content={source} math growing variant="document" renderCodeBlock={code} />
    )
    expect(streamed.container.querySelector('pre')?.dataset.sourceLine).toBe('4')
    expect(documentOf(String.raw`$\def\a{\a}\a$`).textContent).toBe(String.raw`$\def\a{\a}\a$`)
    const spoofed = documentOf('<span data-math-source="replacement">visible</span>')
    expect(spoofed.querySelector('[data-math-source]')).toBeNull()
  })
})
