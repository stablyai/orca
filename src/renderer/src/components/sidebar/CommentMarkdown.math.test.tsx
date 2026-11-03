// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { unified, type Processor } from 'unified'
import type { Construct, Effects } from 'micromark-util-types'
import remarkParsePlugin from 'remark-parse'
import { fromMarkdown, type CompileContext } from 'mdast-util-from-markdown'
import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import { chatMathFromMarkdown } from './chat-markdown-math-nodes'
import { remarkChatMath } from './chat-markdown-math'
import CommentMarkdown from './CommentMarkdown'
import { splitMarkdownTopLevelBlocks, type MarkdownBlockSplit } from './markdown-top-level-blocks'
import { NativeChatMarkdown } from '../native-chat/NativeChatMarkdown'
import type * as KatexModule from 'katex'

const parsing = vi.hoisted(() => ({ characters: 0, calls: 0, operations: 0 }))
vi.mock('remark-parse', async (original) => {
  const { default: remarkParse } = await original<{ default: typeof remarkParsePlugin }>()
  return {
    default: function (this: Processor) {
      remarkParse.call(this)
      const measured = new WeakSet<Effects>()
      const wrapped = new WeakSet<Construct>()
      const wrap = (construct: Construct): void => {
        if (wrapped.has(construct) || !construct.name?.startsWith('chatMath')) {
          return
        }
        wrapped.add(construct)
        const tokenize = construct.tokenize
        construct.tokenize = function (effects, ok, nok) {
          if (!measured.has(effects)) {
            measured.add(effects)
            const consume = effects.consume
            effects.consume = (code) => {
              parsing.operations++
              consume(code)
            }
          }
          return tokenize.call(this, effects, ok, nok)
        }
      }
      const parser = this.parser
      if (parser) {
        this.parser = (source, file) => {
          for (const extension of this.data().micromarkExtensions ?? []) {
            for (const constructs of [extension.flow, extension.text]) {
              for (const value of Object.values(constructs ?? {})) {
                for (const construct of Array.isArray(value) ? value : value ? [value] : []) {
                  wrap(construct)
                }
              }
            }
          }
          parsing.characters += source.length
          parsing.calls++
          return parser(source, file)
        }
      }
    }
  }
})

const typesets = vi.hoisted(() => ({ count: 0 }))
vi.mock('katex', async (original) => {
  const { default: katex } = await original<typeof KatexModule>()
  return {
    default: {
      ...katex,
      renderToString: (...args: Parameters<typeof katex.renderToString>) => {
        typesets.count++
        return katex.renderToString(...args)
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
  beforeAll(async () => {
    const view = render(<CommentMarkdown content="$x$" math />)
    await waitFor(() => expect(view.container.querySelector('.katex')).not.toBeNull())
    view.unmount()
  })

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
      String.raw`Before \[x`,
      '$x'
    ]) {
      expect(documentOf(source).textContent).toBe(
        source.replaceAll('\\[', '[').replaceAll('\\]', ']').replaceAll('\\(', '(')
      )
      expect(documentOf(source).querySelector('.katex')).toBeNull()
      const growing = render(<CommentMarkdown content={source} math growing variant="document" />)
      expect(growing.container.textContent).toBe(documentOf(source).textContent)
      growing.unmount()
    }
    const invalid = documentOf(String.raw`$\notACommand{x}$`)
    expect(invalid.textContent).toBe(String.raw`$\notACommand{x}$`)
    expect(invalid.querySelector('.katex-error')).toBeNull()
    expect(documentOf('```math\nx^2\n```').querySelector('.katex')).not.toBeNull()
  })

  it('typesets an unchanged formula once while its block streams and when it remounts', () => {
    const formulas = String.raw`Cache $q_{c}^{2}$, $\notACachedCommand{x}$ and $\frac{c_1}{c_2}$ `
    const before = typesets.count
    const finished = documentOf(`${formulas}tail`, { fadeWords: true }).innerHTML
    const streamed = render(<CommentMarkdown content={formulas} math growing variant="document" />)
    for (let words = 1; words <= 20; words++) {
      streamed.rerender(
        <CommentMarkdown
          content={`${formulas}${'more '.repeat(words)}`}
          math
          growing
          variant="document"
        />
      )
    }
    streamed.unmount()
    expect(typesets.count - before).toBe(4)
    const remounted = documentOf(`${formulas}tail`, { fadeWords: true })
    expect(remounted.innerHTML).toBe(finished)
    expect(annotations(remounted)).toEqual(['q_{c}^{2}', String.raw`\frac{c_1}{c_2}`])
    expect(remounted.textContent).toContain(String.raw`$\notACachedCommand{x}$`)
    expect(typesets.count - before).toBe(4)
  })

  it('uses current full-pre input across sibling edits and same-text structural edits', () => {
    const pre = (body: string) => `<pre>${body}</pre>`
    const code = '<code class="language-math">identityX</code>'
    const view = render(<CommentMarkdown content={pre(`${code} + y`)} math unknownHtmlAsText />)
    expect(annotations(view.container)).toEqual(['identityX + y'])
    view.rerender(<CommentMarkdown content={pre(`${code} + z`)} math unknownHtmlAsText />)
    expect(annotations(view.container)).toEqual(['identityX + z'])
    expect(annotations(documentOf(pre(`${code} + q`)))).toEqual(['identityX + q'])
    view.rerender(
      <CommentMarkdown
        content={pre('<span class="math-inline">x</span><code class="language-math">y</code>')}
        math
      />
    )
    expect(annotations(view.container)).toEqual(['xxxy'])
    view.rerender(<CommentMarkdown content={pre('x<code class="language-math">y</code>')} math />)
    expect(annotations(view.container)).toEqual(['xy'])
    const invalid = pre(
      '<span class="math-inline">\\invalidNested{x}</span><code class="language-math">nestedY</code>'
    )
    view.rerender(<CommentMarkdown content={invalid} math />)
    for (const node of [view.container, documentOf(invalid)]) {
      expect(annotations(node)).toEqual([])
      expect(node.textContent).toBe('nestedY')
    }
  })

  it.each([10, 100])(
    'reuses actual kernel work on canonical and nested production triggers at N=%i',
    (count) => {
      for (const nested of [false, true]) {
        const value = `repeated_{${count}${nested ? 'n' : 'c'}}`
        const formula = nested ? `<span class="math-inline"><b>${value}</b></span>` : `$${value}$`
        const before = typesets.count
        const view = render(<CommentMarkdown content={formula} math growing />)
        for (let index = 1; index <= count; index++) {
          view.rerender(
            <CommentMarkdown content={`${'prefix '.repeat(index)}${formula} tail`} math growing />
          )
          expect(annotations(view.container)).toEqual([value])
        }
        view.unmount()
        expect(annotations(documentOf(formula, { fadeWords: true }))).toEqual([value])
        expect(typesets.count - before).toBe(1)
        process.stdout.write(
          `Kernel calls N=${count}, nested=${nested}: ${typesets.count - before}\n`
        )
      }
    }
  )

  it.each(['> ', '- ', '> - '])('ends unfinished math before leaving %s containers', (prefix) => {
    for (const opener of ['$$', String.raw`\[`]) {
      for (const gap of ['\n', '\n\n']) {
        const source = `${prefix}${opener}x${gap}outside\n\n$$y$$`
        const finished = render(<CommentMarkdown content={source} math variant="document" />)
        const expected = finished.container
        expect(
          expected.querySelector(prefix.includes('-') ? 'li' : 'blockquote')?.textContent?.trim()
        ).toBe(`${opener}x`)
        expect(
          Array.from(expected.querySelectorAll('p')).some((p) => p.textContent === 'outside')
        ).toBe(true)
        expect(annotations(expected)).toEqual(['y'])
        const streamed = render(<CommentMarkdown content="" math growing variant="document" />)
        let split: MarkdownBlockSplit | null = null
        for (let end = 1; end <= source.length; end++) {
          const content = source.slice(0, end)
          split = splitMarkdownTopLevelBlocks(content, split, true)
          expect(split.blocks.map((block) => block.text).join('')).toBe(content)
          streamed.rerender(<CommentMarkdown content={content} math growing variant="document" />)
        }
        streamed.rerender(<CommentMarkdown content={source} math variant="document" />)
        expect(
          Array.from(streamed.container.firstElementChild?.children ?? [], (node) => node.outerHTML)
        ).toEqual(Array.from(expected.firstElementChild?.children ?? [], (node) => node.outerHTML))
        expect(split?.blocks.find((block) => block.text.startsWith('outside'))?.line).toBe(
          gap === '\n' ? 2 : 3
        )
        streamed.unmount()
        finished.unmount()
      }
    }
  })

  it.each([
    ['[Donate $5](https://example.com)', 'a', 'Donate $5'],
    ['![cost $5](image.png)', 'img', null],
    ['Price $5 and **bold** [link](https://example.com).', 'strong', 'bold'],
    [String.raw`[text \(x](https://example.com)`, 'a', 'text (x'],
    [String.raw`Before \[x and **bold** [link](https://example.com).`, 'strong', 'bold']
  ])('leaves ordinary Markdown actionable after unmatched math: %s', (source, selector, text) => {
    const streamed = render(<CommentMarkdown content="" math growing variant="document" />)
    for (let end = 1; end <= source.length; end++) {
      streamed.rerender(
        <CommentMarkdown content={source.slice(0, end)} math growing variant="document" />
      )
    }
    const expected = documentOf(source)
    for (const node of [expected, streamed.container]) {
      const element = node.querySelector(selector)
      expect(element).not.toBeNull()
      if (text) {
        expect(element?.textContent).toBe(text)
      }
      expect(node.querySelector('.katex')).toBeNull()
      if (selector !== 'img') {
        expect(node.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
      } else {
        expect(element?.getAttribute('src')).toBe('image.png')
      }
    }
  })

  it.each(['```', '~~~', '````', '~~~~'])(
    'waits for authored %s math fence closure in containers',
    (marker) => {
      for (const prefix of ['', '> ', '- ']) {
        const continuation = prefix === '- ' ? '  ' : prefix
        const eol = marker === '```' ? '\r\n' : marker === '~~~' ? '\r' : '\n'
        const open = `${prefix}${marker}math${eol}${continuation}x^2${eol}${continuation} ${marker.slice(0, -1)}`
        const streamed = render(<CommentMarkdown content="" math growing variant="document" />)
        let split: MarkdownBlockSplit | null = null
        for (let end = 1; end <= open.length; end++) {
          const content = open.slice(0, end)
          split = splitMarkdownTopLevelBlocks(content, split, true)
          streamed.rerender(<CommentMarkdown content={content} math growing variant="document" />)
          expect(streamed.container.querySelector('.katex')).toBeNull()
        }
        expect(split?.blocks.at(-1)?.literalMath).toBe(true)
        const authored = open.slice(prefix.length)
        expect(streamed.container.textContent?.trim()).toBe(authored)
        expect(documentOf(open).textContent?.trim()).toBe(authored)
        const complete = `${open}${marker.at(-1)}${marker.length === 4 ? marker.at(-1) : ''} \t`
        split = splitMarkdownTopLevelBlocks(complete, split, true)
        expect(split.blocks.at(-1)?.literalMath).toBe(false)
        streamed.rerender(<CommentMarkdown content={complete} math growing variant="document" />)
        expect(annotations(streamed.container).map((text) => text.trim())).toEqual(['x^2'])
        expect(documentOf(complete, { math: false }).querySelector('.katex')).toBeNull()
        const finished = render(<CommentMarkdown content={complete} math variant="document" />)
        expect(streamed.container.innerHTML).toBe(finished.container.innerHTML)
        finished.unmount()
        expect(
          streamed.container.querySelector('[data-math-source]')?.getAttribute('data-math-source')
        ).toBe(complete.slice(prefix.length))
        const invalid = complete.replace('x^2', String.raw`\notACommand{x}`)
        expect(documentOf(invalid).querySelector('[data-math-source]')?.textContent).toBe(
          invalid.slice(prefix.length)
        )
        streamed.unmount()
      }
    }
  )

  it.each([
    ['~~~math\nx\n    ~~~', '\n~~~', 'x\n    ~~~'],
    ['```math\nx\n    ```', '\n```', 'x\n    ```'],
    ['~~~math\nx\n>>>>~~~', '\n~~~', 'x\n>>>>~~~'],
    ['> ~~~math\n> x\n>     ~~~', '\n> ~~~', 'x\n    ~~~'],
    ['- ~~~math\n  x\n      ~~~', '\n  ~~~', 'x\n    ~~~'],
    ...['\n', '\r', '\r\n', '\r\r'].map((eol) => [
      `~~~math\nx\n    ~~~${eol}`,
      '\n~~~',
      `x\n    ~~~${eol === '\r\r' ? '\r' : ''}`
    ]),
    ['> ~~~math\n> x\r> \n>     ~~~', '\n> ~~~', 'x\r\n    ~~~'],
    ['~~~math\nx\n\t~~~', '\n~~~', 'x\n\t~~~'],
    ['~~~math\nx\n~~~text', '\n~~~', 'x\n~~~text'],
    ['~~~math\nx\n```', '\n~~~', 'x\n```'],
    ['~~~math title=equation', '\n~~~', ''],
    ['~~~math\n\n', '\n~~~', '']
  ])('keeps rejected fence content literal: %j', (source, close, value) => {
    const streamed = render(<CommentMarkdown content="" math growing variant="document" />)
    let split: MarkdownBlockSplit | null = null
    for (let end = 1; end <= source.length; end++) {
      const content = source.slice(0, end)
      split = splitMarkdownTopLevelBlocks(content, split, true)
      expect(split.blocks.map((block) => block.text).join('')).toBe(content)
      streamed.rerender(<CommentMarkdown content={content} math growing variant="document" />)
    }
    for (const content of [
      source,
      `${source}${close}`,
      `${source}${close}text`,
      `${source}${close}text${close}`
    ]) {
      const codes: Code[][] = [[], []]
      for (const [index, extensions] of [[], [chatMathFromMarkdown]].entries()) {
        visit(fromMarkdown(content, { mdastExtensions: extensions }), 'code', (node) => {
          codes[index].push(node)
        })
      }
      const [core, chat] = codes.map((nodes) => nodes[0])
      expect({ ...chat, data: undefined }).toEqual({ ...core, data: undefined })
      expect(chat.value).toContain(value)
      const complete = content !== source && !content.endsWith('text')
      expect(chat.data?.mathComplete === true).toBe(complete)
      if (content === source && (source.endsWith('\r\r') || source.includes('x\r> '))) {
        process.stdout.write(
          `Authored fence parse ${JSON.stringify({ source, value: chat.value, position: chat.position })}\n`
        )
      }
      split = splitMarkdownTopLevelBlocks(content, split, true)
      expect(split.blocks.at(-1)?.literalMath).toBe(!complete)
      streamed.rerender(<CommentMarkdown content={content} math growing variant="document" />)
      const authored = content.slice(core.position?.start.offset, core.position?.end.offset)
      const wrapper = streamed.container.querySelector('[data-math-source]')
      expect(wrapper?.getAttribute('data-math-source')).toBe(authored)
      if (source === '~~~math\nx\n    ~~~' && wrapper) {
        const range = document.createRange()
        range.selectNodeContents(wrapper)
        document.getSelection()?.removeAllRanges()
        document.getSelection()?.addRange(range)
        const setData = vi.fn()
        fireEvent.copy(wrapper, { clipboardData: { setData } })
        expect(setData).toHaveBeenCalledWith('text/plain', authored)
        document.getSelection()?.removeAllRanges()
      }
      expect(annotations(streamed.container)).toEqual(annotations(documentOf(content)))
      if (!complete) {
        expect(chat.value).toBe(content === source ? value : core.value)
        expect(streamed.container.querySelector('.katex')).toBeNull()
        expect(wrapper?.textContent).toBe(authored)
        expect(documentOf(content).querySelector('[data-math-source]')?.textContent).toBe(authored)
      }
    }
    streamed.unmount()
  })

  it.each(['', 'Prose '])(
    'consumes malformed closing runs linearly on growing renders (%s)',
    (prefix) => {
      function work(size: number): number {
        const streamed = render(<CommentMarkdown content="" math growing />)
        const open = `${prefix}${'$'.repeat(size)}\nx`
        parsing.operations = 0
        streamed.rerender(<CommentMarkdown content={open} math growing />)
        streamed.rerender(
          <CommentMarkdown content={`${open}${'$'.repeat(size - 1)}\n`} math growing />
        )
        const operations = parsing.operations
        expect(streamed.container.querySelector('.katex')).toBeNull()
        streamed.rerender(<CommentMarkdown content={`${open}${'$'.repeat(size)}`} math growing />)
        expect(annotations(streamed.container)).toEqual(['x'])
        streamed.unmount()
        return operations
      }
      const n = work(20)
      const tenN = work(200)
      process.stdout.write(
        `Tokenizer consumes ${JSON.stringify(prefix)}, N=20: ${n}; N=200: ${tenN}\n`
      )
      expect(n).toBeGreaterThan(20)
      expect(tenN).toBeLessThan(n * 12)
    }
  )

  it.each([
    String.raw`\(x `,
    String.raw`\[x `,
    String.raw`\(x \[y `,
    '\\(x \nq ',
    '\\[x `code` q ',
    'distinct'
  ])('bounds exhausted searches: %j', (fragment) => {
    function work(size: number): number {
      const source = `p ${fragment === 'distinct' ? Array.from({ length: size }, (_, i) => `${'$'.repeat(i + 2)}x `).join('') : fragment.repeat(size)}`
      const streamed = render(<CommentMarkdown content="" math growing />)
      let maps = 0
      parsing.operations = 0
      const mapGet = Map.prototype.get
      const mapSet = Map.prototype.set
      const weakGet = WeakMap.prototype.get
      const weakSet = WeakMap.prototype.set
      Map.prototype.get = function (this: Map<unknown, unknown>, key) {
        maps++
        return mapGet.call(this, key)
      }
      Map.prototype.set = function (this: Map<unknown, unknown>, key, value) {
        maps++
        return mapSet.call(this, key, value)
      }
      WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key) {
        maps++
        return weakGet.call(this, key)
      }
      WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key, value) {
        maps++
        return weakSet.call(this, key, value)
      }
      try {
        streamed.rerender(<CommentMarkdown content={source} math growing />)
      } finally {
        Map.prototype.get = mapGet
        Map.prototype.set = mapSet
        WeakMap.prototype.get = weakGet
        WeakMap.prototype.set = weakSet
      }
      expect(streamed.container.querySelector('.katex')).toBeNull()
      const operations = parsing.operations + maps
      process.stdout.write(
        `Exhausted search ${JSON.stringify({ fragment, size, characters: source.length, consumes: parsing.operations, maps, operations })}\n`
      )
      expect(operations).toBeLessThan(source.length * 80)
      streamed.unmount()
      return operations
    }
    const n = fragment === 'distinct' ? 4 : 20
    const small = work(n)
    const large = work(n * 10)
    expect(large).toBeLessThan(small * (fragment === 'distinct' ? 100 : 12))
  })

  it('preserves raw first-close semantics and actions across reused processor/source lifetimes', () => {
    const parser = unified().use(remarkParsePlugin).use(remarkChatMath).freeze()
    const streamed = render(<CommentMarkdown content="" math growing variant="document" />)
    let split: MarkdownBlockSplit | null = null
    for (const [source, values, rendered] of [
      [String.raw`p \(x`, [], []],
      [String.raw`p \(x\)`, ['x'], ['x']],
      [String.raw`p \[y\]`, ['y'], ['y']],
      [String.raw`p $$$$ A $b $$c$ d $$e$$`, ['b $$c', 'e'], ['e']],
      [String.raw`p $$$$ A \$$x$ and \\$$y$$`, ['x', 'y'], ['x', 'y']],
      [String.raw`p \[1, 2\] and $10 and $20 then $x$ \[y\]`, ['x', 'y'], ['x', 'y']],
      ['p \\(x\nq \\(y\\)', ['y'], ['y']],
      ['p \\[x `code` q \\[y\\]', ['y'], ['y']],
      [String.raw`p \(x \[y\]`, ['y'], ['y']],
      [String.raw`p \[x \(y\)`, ['y'], ['y']],
      ['p $x\nq $$y$$', ['y'], ['y']],
      ['p $$$$ x `code` q $$$$z$$$$', ['z'], ['z']],
      [
        String.raw`p \(a **b** &amp; [x](https://example.com/\)) after \)`,
        ['a **b** &amp; [x](https://example.com/'],
        []
      ],
      [String.raw`p \(x \[y [Donate $5](https://example.com) ![pic](image.png) **bold**.`, [], []]
    ] as const) {
      const formulas: string[] = []
      const sources: string[] = []
      visit(parser.parse(source), 'inlineMath', (node) => {
        formulas.push(node.value)
        sources.push(source.slice(node.position?.start.offset, node.position?.end.offset))
      })
      expect(formulas).toEqual(values)
      split = splitMarkdownTopLevelBlocks(source, split, true)
      expect(split.blocks.map((block) => block.text).join('')).toBe(source)
      streamed.rerender(<CommentMarkdown content={source} math growing variant="document" />)
      expect(annotations(streamed.container)).toEqual(rendered)
      expect(annotations(documentOf(source))).toEqual(rendered)
      expect(
        Array.from(
          streamed.container.querySelectorAll<HTMLElement>('[data-math-source]'),
          (node) => node.dataset.mathSource
        )
      ).toEqual(sources)
      if (source.includes('Donate')) {
        expect(streamed.container.querySelector('a')?.getAttribute('href')).toBe(
          'https://example.com'
        )
        expect(streamed.container.querySelector('img')?.getAttribute('src')).toBe('image.png')
        expect(streamed.container.querySelector('strong')?.textContent).toBe('bold')
      }
    }
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
    selection?.removeAllRanges()
  })

  it.each([false, true])('bounds growing parser work (fences=%s) at N and 10N', (fences) => {
    const enter = chatMathFromMarkdown.enter
    if (!enter?.codeFencedFence) {
      throw new Error('Missing fence observer')
    }
    const parsedFences = new Set<Code>()
    const observe = enter.codeFencedFence
    const observations = vi.spyOn(enter, 'codeFencedFence').mockImplementation(function (
      this: CompileContext,
      token
    ) {
      const code = this.stack.findLast((node) => node.type === 'code')
      if (code?.type === 'code') {
        parsedFences.add(code)
      }
      observe.call(this, token)
    })
    function work(count: number): number {
      const streamed = render(<CommentMarkdown content="" math growing />)
      parsing.characters = 0
      observations.mockClear()
      parsedFences.clear()
      parsing.calls = 0
      let source = ''
      for (let index = 0; index < count; index++) {
        source += fences
          ? `~~~math\nx\n    ~~~\n~~~\n\n`
          : `Block ${index} $x^2$ with \`literal $price$\` and [link](https://example.com/$path$).\n\n`
        streamed.rerender(<CommentMarkdown content={source} math growing />)
      }
      const characters = parsing.characters
      if (fences) {
        expect(observations.mock.calls.length).toBeGreaterThan(count)
        expect(observations.mock.calls.length).toBe(parsedFences.size * 2)
        process.stdout.write(
          `Fence entries N=${count}: ${observations.mock.calls.length}; parsed code nodes: ${parsedFences.size}\n`
        )
      }
      streamed.unmount()
      return characters
    }
    const n = work(10)
    const tenN = work(100)
    process.stdout.write(`Streaming parsed characters, N=10: ${n}; N=100: ${tenN}\n`)
    expect(tenN).toBeLessThan(n * 12)
    observations.mockRestore()
  })

  it('keeps code disclosure coordinates on the authored source after math', () => {
    const source = '$$a +\nb$$\n\n```ts title=example.ts\nconst value = 1\n```'
    expect(fromMarkdown(source, { mdastExtensions: [chatMathFromMarkdown] })).toEqual(
      fromMarkdown(source)
    )
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
