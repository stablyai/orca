import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Root } from 'hast'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import katex from 'katex'
import 'rehype-katex'
import { VFile } from 'vfile'
import { visit } from 'unist-util-visit'
import type { BoundedMap, BoundedMapOptions } from '../../../../shared/collections/bounded-map'
import type * as BoundedModule from '../../../../shared/collections/bounded-map'
import { typesetChatMath } from './chat-markdown-math-typeset'

const retained = vi.hoisted((): { cache?: BoundedMap<string, unknown> } => ({}))
vi.mock('../../../../shared/collections/bounded-map', async (original) => {
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

beforeEach(() => {
  cache().clear()
  vi.restoreAllMocks()
})

describe('bounded immutable math kernel results', () => {
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
