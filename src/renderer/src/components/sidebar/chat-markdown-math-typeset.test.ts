import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Root } from 'hast'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import katex from 'katex'
import rehypeKatex from 'rehype-katex'
import { VFile } from 'vfile'
import { visit } from 'unist-util-visit'
import type { BoundedMap, BoundedMapOptions } from '../../../../shared/bounded-map'
import type * as BoundedModule from '../../../../shared/bounded-map'
import { typesetChatMath } from './chat-markdown-math-typeset'

const retained = vi.hoisted((): { cache?: BoundedMap<string, unknown> } => ({}))
vi.mock('../../../../shared/bounded-map', async (original) => {
  const { BoundedMap: Real } = await original<typeof BoundedModule>()
  return {
    BoundedMap: class extends Real<string, unknown> {
      constructor(options: BoundedMapOptions<string, unknown>) {
        super(options)
        retained.cache = this
      }
    }
  }
})
const settings = { trust: false, maxSize: 20, maxExpand: 1000, strict: 'ignore' } as const
const original = rehypeKatex(settings)
function cache(): BoundedMap<string, unknown> {
  if (!retained.cache) {
    throw new Error('Missing production cache')
  }
  return retained.cache
}
function run(source: string, transform = typesetChatMath, line = 1): { tree: Root; file: VFile } {
  const tree = fromHtmlIsomorphic(source, { fragment: true })
  for (const child of tree.children) {
    child.position = {
      start: { line, column: 1, offset: line - 1 },
      end: { line, column: source.length + 1, offset: line - 1 + source.length }
    }
  }
  const file = new VFile()
  transform(tree, file)
  return { tree, file }
}
const span = (value: string) => `<span class="math-inline">${value}</span>`
const warnings = (file: VFile) =>
  file.messages.map(({ reason, source, ruleId, place, cause }) => ({
    reason,
    source,
    ruleId,
    place,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  }))
beforeEach(() => {
  cache().clear()
  vi.restoreAllMocks()
})

describe('bounded immutable math kernel results', () => {
  it('matches the installed transformer on cold/hit traversal, modes, failures and current positions', () => {
    const corpus = [
      span('x^2'),
      '<div class="math-display">x^2</div>',
      '<pre><code class="language-math">x^2\n</code></pre>',
      '<pre><code class="language-math">x</code> + y</pre>',
      '<pre><span class="math-inline">x</span><code class="language-math">y</code></pre>',
      '<pre>x<code class="language-math">y</code></pre>',
      '<pre title="retained"><code class="math-inline">x</code> sibling</pre>',
      span('<b>x</b><i>+y</i>'),
      span('\\notACommand{x}'),
      '<pre><span class="math-inline">\\notACommand{x}</span><code class="language-math">y</code></pre>',
      span('\\gdef\\a{x}\\a') + span('\\a'),
      span('\\rule{100em}{100em}'),
      span('\\def\\a{\\a}\\a'),
      span('\\href{https://example.com}{x}')
    ]
    for (const source of corpus) {
      for (const prefix of ['', 'shift\n']) {
        const expected = run(prefix + source, original, prefix ? 2 : 1)
        const actual = run(prefix + source, typesetChatMath, prefix ? 2 : 1)
        expect(actual.tree).toEqual(expected.tree)
        expect(warnings(actual.file)).toEqual(warnings(expected.file))
        if (actual.file.messages.length) {
          expect(actual.file.messages[0].ancestors?.at(-1)).not.toBe(
            expected.file.messages[0].ancestors?.at(-1)
          )
        }
      }
    }
  })

  it('gives consumers private trees and rebuilds current-context compact failure diagnostics', () => {
    const source = span('privateX')
    const expected = run(source).tree
    visit(run(source).tree, 'text', (node) => {
      node.value = 'mutated by a consumer'
    })
    expect(run(source).tree).toEqual(expected)
    const calls = vi.spyOn(katex, 'renderToString')
    const invalid = span('\\invalidCompact{x}')
    const first = run(invalid)
    const second = run(`\n${invalid}`, typesetChatMath, 9)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(first.file.messages).toHaveLength(1)
    expect(second.file.messages).toHaveLength(1)
    expect(second.file.messages[0].line).toBe(9)
    expect(first.file.messages[0].cause).not.toBe(second.file.messages[0].cause)
    expect(
      cache()
        .values()
        .find(
          (value) =>
            typeof value === 'object' && value !== null && 'failure' in value && value.failure
        )
    ).toMatchObject({
      failure: { name: 'ParseError', message: expect.any(String), title: expect.any(String) }
    })
    for (const value of cache().values()) {
      expect(value).not.toBeInstanceOf(Error)
      expect(Object.keys(Object(value))).toEqual(['html', 'failure'])
    }
  })
})
