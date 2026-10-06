import { describe, expect, it } from 'vitest'
import type { Nodes } from 'hast'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import {
  parseMarkdownPreviewDocument,
  renderMarkdownPreviewBlock,
  countMarkdownPreviewNodes
} from './markdown-preview-document-tree'
import { MARKDOWN_PREVIEW_BLOCK_MAX_NODES } from './markdown-preview-document-types'
import { markdownPreviewScrollAnchorKey } from './use-markdown-preview-scroll-anchor'

function elements(node: Nodes): Nodes[] {
  return [node, ...('children' in node ? node.children.flatMap(elements) : [])]
}

const table = `| Item | Value |\n| --- | --- |\n${Array.from(
  { length: 1500 },
  (_, index) => `| Item ${index} | Value ${index} |`
).join('\n')}`

describe('large preview table row groups', () => {
  it('preserves every row once, shared column widths, and per-group source positions', () => {
    const { tree, document } = parseMarkdownPreviewDocument(table)
    expect(tree.children.length).toBeGreaterThan(1)
    const nodes = elements(tree)
    expect(
      nodes.filter((node) => node.type === 'element' && node.tagName === 'thead')
    ).toHaveLength(1)
    expect(nodes.filter((node) => node.type === 'element' && node.tagName === 'tr')).toHaveLength(
      1501
    )
    for (const [index, node] of tree.children.entries()) {
      const rendered = renderMarkdownPreviewBlock(node, index)
      expect(rendered.oversized).toBe(false)
      expect(
        countMarkdownPreviewNodes(rendered.tree, MARKDOWN_PREVIEW_BLOCK_MAX_NODES)
      ).toBeLessThan(MARKDOWN_PREVIEW_BLOCK_MAX_NODES)
      expect(
        elements(rendered.tree).filter(
          (entry) => entry.type === 'element' && entry.tagName === 'col'
        )
      ).toEqual([
        expect.objectContaining({ properties: { style: 'width: 50%' } }),
        expect.objectContaining({ properties: { style: 'width: 50%' } })
      ])
      if (index > 0) {
        expect(document.blocks[index].sourceLine).toBe(
          document.blocks[index - 1].sourceEndLine! + 1
        )
      }
    }
    expect(document.blocks[0].sourceLine).toBe(1)
    expect(document.blocks.at(-1)?.sourceEndLine).toBe(1502)
  })

  it('keeps later source anchors stable when an early cell changes row grouping', () => {
    const before = parseMarkdownPreviewDocument(table).document.blocks
    const after = parseMarkdownPreviewDocument(
      table.replace('Item 0', `Item 0 ${'x'.repeat(9000)}`)
    ).document.blocks
    expect(after.length).toBeGreaterThan(before.length)
    const last = before.at(-1)!
    expect(after.at(-1)?.index).not.toBe(last.index)
    expect(markdownPreviewScrollAnchorKey(after.at(-1)!)).toBe(markdownPreviewScrollAnchorKey(last))
    for (const block of before.slice(1)) {
      expect(
        after.some(
          (candidate) =>
            markdownPreviewScrollAnchorKey(candidate) === markdownPreviewScrollAnchorKey(block)
        )
      ).toBe(true)
    }
  })

  it('finds EOF rows and only one header occurrence', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    const document = engine.load(table)
    const result = await engine.search('Value 1499')
    expect(result?.matches).toEqual([{ block: document.blocks.length - 1, occurrence: 0 }])
    expect((await engine.search('Item'))?.matches).toHaveLength(1501)
  })

  it('keeps an excessive row unavailable without hiding its neighboring rows', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      `| Item | Value |\n| --- | --- |\n| before | available |\n| enormous | ${'x'.repeat(40_000)} |\n| after | available |`
    )
    expect(engine.blocks([0, 1, 2]).map((block) => block.oversized)).toEqual([false, true, false])
    expect((await engine.search('available'))?.matches).toHaveLength(2)
  })

  it('preserves a small header when the first body row is excessive', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    const document = engine.load(
      `| Item | Value |\n| --- | --- |\n| enormous | ${'x'.repeat(40_000)} |\n| after | available |`
    )
    expect(document.blocks[0]).toMatchObject({ sourceLine: 1, sourceEndLine: 2 })
    expect(document.blocks[1]).toMatchObject({ sourceLine: 3, sourceEndLine: 3 })
    const blocks = engine.blocks([0, 1, 2])
    expect(blocks.map((block) => block.oversized)).toEqual([false, true, false])
    expect(
      elements(blocks[0].tree).filter((node) => node.type === 'element' && node.tagName === 'thead')
    ).toHaveLength(1)
    expect((await engine.search('Item'))?.matches).toEqual([{ block: 0, occurrence: 0 }])
    expect((await engine.search('available'))?.matches).toEqual([{ block: 2, occurrence: 0 }])
  })

  it('bounds repeated header context in continuation payloads', () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(`| ${'h'.repeat(100_000)} | Value |\n| --- | --- |\n${'| x | y |\n'.repeat(1500)}`)
    const block = engine.blocks([1])[0]
    expect(block.oversized).toBe(false)
    expect(
      elements(block.tree).find((node) => node.type === 'element' && node.tagName === 'table')
    ).toMatchObject({ properties: { ariaLabel: 'h'.repeat(512) } })
    expect(JSON.stringify(block).length).toBeLessThan(32_768)
  })

  it('keeps table-wide raw HTML attributes on their original atomic table', () => {
    const { tree } = parseMarkdownPreviewDocument(
      `<table title="${'x'.repeat(40_000)}"><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody>${'<tr><td>x</td><td>y</td></tr>'.repeat(1500)}</tbody></table>`
    )
    expect(tree.children).toHaveLength(1)
    expect(renderMarkdownPreviewBlock(tree.children[0], 0).oversized).toBe(true)
  })

  it('enforces the document budget after adding column groups', () => {
    const row = `|${' x |'.repeat(100)}\n`
    const content = `|${' c |'.repeat(100)}\n|${' --- |'.repeat(100)}\n${row.repeat(1300)}`
    expect(() => parseMarkdownPreviewDocument(content)).toThrow('complexity limit')
  })

  it('retains table, body, and row anchors exactly once', () => {
    const content = `<table id="table"><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody id="rows">${Array.from({ length: 1500 }, (_, index) => `<tr id="row-${index}"><td>${index}</td><td>x</td></tr>`).join('')}</tbody></table>`
    const { document } = parseMarkdownPreviewDocument(content)
    const anchors = document.blocks.flatMap((block) => block.anchors)
    expect(anchors.filter((anchor) => anchor === 'user-content-table')).toHaveLength(1)
    expect(anchors.filter((anchor) => anchor === 'user-content-rows')).toHaveLength(1)
    expect(anchors.filter((anchor) => anchor === 'user-content-row-1499')).toHaveLength(1)
  })

  it('leaves small tables and complex spanning tables intact', () => {
    const { tree } = parseMarkdownPreviewDocument('| a | b |\n| --- | --- |\n| x | y |')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ properties: {} })
    const { tree: spanning } = parseMarkdownPreviewDocument(
      `<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td colspan="2">${'x'.repeat(40_000)}</td></tr></tbody></table>`
    )
    expect(spanning.children).toHaveLength(1)
    expect(renderMarkdownPreviewBlock(spanning.children[0], 0).oversized).toBe(true)
  })
})
