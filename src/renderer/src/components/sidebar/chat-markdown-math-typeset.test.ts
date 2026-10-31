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

  it('rebuilds the library fallback when both kernel attempts throw', () => {
    const calls = vi.spyOn(katex, 'renderToString').mockImplementation(() => {
      throw new Error('kernel failed')
    })
    const source = span('thirdPath')
    const expected = run(source, original)
    for (let index = 0; index < 2; index++) {
      const actual = run(source)
      expect(actual.tree).toEqual(expected.tree)
      expect(warnings(actual.file)).toEqual(warnings(expected.file))
    }
    expect(calls).toHaveBeenCalledTimes(4)
  })

  it('bounds entries and promotes hits before evicting the least-recently-used result', () => {
    const calls = vi.spyOn(katex, 'renderToString')
    for (let index = 0; index < 1000; index++) {
      run(span(`%entry${index}`))
    }
    expect(cache().size).toBe(1000)
    run(span('%entry0'))
    run(span('%entry1000'))
    expect(cache().size).toBe(1000)
    expect(cache().has('inline:%entry0')).toBe(true)
    expect(cache().has('inline:%entry1')).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1001)
    run(span('%entry1'))
    expect(calls).toHaveBeenCalledTimes(1002)
  })

  it('accounts keys, HTML, failure strings and metadata; evicts by bytes and bypasses oversized inputs without changing output', () => {
    const source = `x%${'a'.repeat(200000)}`
    for (let index = 0; index < 6; index++) {
      run(span(source + index))
    }
    expect(cache().size).toBeLessThan(6)
    expect(cache().retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(cache().has(`inline:${source}0`)).toBe(false)
    const oldest = cache().keys()[0]
    const weight = cache().retainedBytes
    const oversized = span(`x%${'b'.repeat(2100000)}`)
    const calls = vi.spyOn(katex, 'renderToString')
    const first = run(oversized)
    expect(first.tree).toEqual(run(oversized, original).tree)
    expect(run(oversized).tree).toEqual(first.tree)
    expect(calls).toHaveBeenCalledTimes(3)
    expect(cache().keys()[0]).toBe(oldest)
    expect(cache().retainedBytes).toBe(weight)
    const oversizedInvalid = span(`\\invalidOversized%${'c'.repeat(2100000)}`)
    const expectedFailure = run(oversizedInvalid, original)
    for (let index = 0; index < 2; index++) {
      const actual = run(oversizedInvalid)
      expect(actual.tree).toEqual(expectedFailure.tree)
      expect(warnings(actual.file)).toEqual(warnings(expectedFailure.file))
    }
    expect(cache().retainedBytes).toBe(weight)
    run(span('\\invalidAccounting{x}'))
    let accounted = 0
    for (const [key, value] of cache().entries()) {
      if (typeof value !== 'object' || value === null) {
        throw new Error('Expected compact result')
      }
      let characters = key.length
      if ('html' in value && typeof value.html === 'string') {
        characters += value.html.length
      }
      if ('failure' in value && value.failure) {
        expect(Object.values(value.failure).every((field) => typeof field === 'string')).toBe(true)
        for (const field of Object.values(value.failure)) {
          if (typeof field === 'string') {
            characters += field.length
          }
        }
      }
      accounted += 256 + characters * 2
    }
    expect(cache().retainedBytes).toBe(accounted)
  })
})
