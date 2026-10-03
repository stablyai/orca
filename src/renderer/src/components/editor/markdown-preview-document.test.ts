import { describe, expect, it, vi } from 'vitest'
import type { Nodes, RootContent } from 'hast'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_REHYPE_PLUGINS } from './markdown-preview-plugins'
import { renderMarkdownPreviewTree } from './markdown-preview-render-tree'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import {
  parseMarkdownPreviewDocument,
  renderMarkdownPreviewBlock,
  countMarkdownPreviewNodes
} from './markdown-preview-document-tree'
import {
  MARKDOWN_PREVIEW_BLOCK_MAX_NODES,
  MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES,
  MARKDOWN_PREVIEW_MAX_SEARCH_MATCHES,
  MARKDOWN_PREVIEW_VIEWPORT_MAX_NODES
} from './markdown-preview-document-types'

function elements(node: Nodes): Nodes[] {
  return [node, ...('children' in node ? node.children.flatMap(elements) : [])]
}

describe('large Markdown preview documents', () => {
  it('rejects atomic blocks before allocating a copy of their trees', () => {
    const { tree } = parseMarkdownPreviewDocument(`\`\`\`text\n${'x'.repeat(32_769)}\n\`\`\``)
    const broadBlock: RootContent = {
      type: 'element',
      tagName: 'div',
      properties: {},
      children: Array.from({ length: MARKDOWN_PREVIEW_BLOCK_MAX_NODES }, () => ({
        type: 'text',
        value: 'x'
      }))
    }
    const clone = vi.spyOn(globalThis, 'structuredClone')
    try {
      expect(renderMarkdownPreviewBlock(tree.children[0], 0).oversized).toBe(true)
      expect(renderMarkdownPreviewBlock(broadBlock, 1).oversized).toBe(true)
      expect(clone).not.toHaveBeenCalled()
    } finally {
      clone.mockRestore()
    }
  })

  it('renders the same safe HTML as the ordinary preview pipeline', () => {
    const content =
      '# Repeat\n\n[Global][end] **bold** ~~deleted~~\n\n# Repeat\n\n' +
      '| a | b |\n| --- | --- |\n| x | y |\n\n' +
      '```javascript\nconst value = 42\n```\n\n$x^2$\n\n' +
      '<details open><summary>Read</summary>\n\nNested **content**\n\n</details>\n\n' +
      'Note[^n].\n\n[^n]: A footnote\n\n[end]: https://example.com\n'
    const engine = new MarkdownPreviewDocumentEngine()
    const document = engine.load(content)
    const actual = engine
      .blocks(document.blocks.map((block) => block.index))
      .map((block) => renderToStaticMarkup(renderMarkdownPreviewTree(block.tree, {})))
      .join('')
    const ordinary = renderToStaticMarkup(
      createElement(
        Markdown,
        {
          remarkPlugins: MARKDOWN_REMARK_PLUGINS,
          rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
          urlTransform: markdownPreviewUrlTransform
        },
        content
      )
    )
    expect(actual.replace(/>\n+</g, '><')).toBe(ordinary.replace(/>\n+</g, '><'))
  })

  it('evicts compiled blocks and invalidates searches on document replacement', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('needle\n\n'.repeat(100))
    const first = engine.blocks([0])[0]
    expect(engine.blocks([0])[0]).toBe(first)
    engine.blocks(Array.from({ length: 40 }, (_, index) => index + 1))
    engine.blocks(Array.from({ length: 40 }, (_, index) => index + 41))
    expect(engine.blocks([0])[0]).not.toBe(first)
    const pending = engine.search('needle')
    engine.load('# Replacement')
    expect(await pending).toBeNull()
    expect(await engine.search('needle')).toEqual({ matches: [], truncated: false })
    expect(() => engine.load('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('size limit')
    expect(() => engine.blocks([0])).toThrow('Invalid preview viewport')
  })

  it('keeps global heading IDs, source lines, and references defined after the viewport', () => {
    const { tree, document } = parseMarkdownPreviewDocument(
      '# Same\n\n[Read][end]\n\n# Same\n\n[end]: https://example.com\n'
    )
    expect(document.blocks.flatMap((block) => block.anchors)).toEqual(['same', 'same-1'])
    expect(document.toc.map((item) => item.id)).toEqual(['same', 'same-1'])
    expect(document.blocks.map((block) => block.sourceLine)).toEqual([1, 3, 5])
    expect(
      elements(tree).find((node) => node.type === 'element' && node.tagName === 'a')
    ).toMatchObject({ properties: { href: 'https://example.com' } })
  })

  it('preserves raw HTML nesting across Markdown blocks and sanitizes executable HTML', () => {
    const { tree } = parseMarkdownPreviewDocument(
      '<details open>\n<summary>Read</summary>\n\n**Nested**\n\n</details>\n\n<script>alert(1)</script>\n\n<img src="javascript:alert(1)" onerror="alert(1)">'
    )
    const nodes = elements(tree)
    expect(nodes.some((node) => node.type === 'element' && node.tagName === 'script')).toBe(false)
    const details = nodes.find((node) => node.type === 'element' && node.tagName === 'details')
    expect(details).toMatchObject({
      properties: { open: true },
      children: expect.arrayContaining([expect.objectContaining({ tagName: 'p' })])
    })
    expect(nodes.find((node) => node.type === 'element' && node.tagName === 'img')).toMatchObject({
      properties: {}
    })
  })

  it('expands math and syntax highlighting only when the block is requested', () => {
    const { tree } = parseMarkdownPreviewDocument('$x^2$\n\n```javascript\nconst value = 3\n```\n')
    expect(
      elements(tree).some(
        (node) => node.type === 'element' && node.properties.className?.toString().includes('katex')
      )
    ).toBe(false)
    const math = renderMarkdownPreviewBlock(tree.children[0], 0)
    const code = renderMarkdownPreviewBlock(tree.children[1], 1)
    expect(
      elements(math.tree).some(
        (node) => node.type === 'element' && node.properties.className?.toString().includes('katex')
      )
    ).toBe(true)
    expect(
      elements(code.tree).some(
        (node) => node.type === 'element' && node.properties.className?.toString().includes('hljs')
      )
    ).toBe(true)
    expect(
      elements(tree).some(
        (node) => node.type === 'element' && node.properties.className?.toString().includes('katex')
      )
    ).toBe(false)
  })

  it('rejects giant atomic blocks and excessive input without attempting a full DOM', () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(`\`\`\`javascript\n${'const value = 3;\n'.repeat(10_000)}\`\`\``)
    expect(engine.blocks([0])).toEqual([
      { index: 0, oversized: true, tree: { type: 'root', children: [] } }
    ])
    expect(() => engine.load('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('size limit')
    expect(() => engine.load('🙂'.repeat(3 * 1024 * 1024))).toThrow('size limit')
    expect(() => engine.blocks([-1])).toThrow('Invalid preview viewport')
    expect(() => engine.blocks(Array.from({ length: 41 }, (_, index) => index))).toThrow(
      'Invalid preview viewport'
    )
  })

  it('bounds document and viewport complexity independently of source bytes', () => {
    const child = { type: 'text', value: 'x' }
    expect(
      countMarkdownPreviewNodes(
        { children: Array.from({ length: MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES }, () => child) },
        MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES
      )
    ).toBe(MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES + 1)
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      Array.from(
        { length: 40 },
        () => `| a | b |\n| --- | --- |\n${'| a | b |\n'.repeat(100)}`
      ).join('\n\n')
    )
    const blocks = engine.blocks(Array.from({ length: 40 }, (_, index) => index))
    expect(
      blocks.reduce(
        (sum, block) =>
          sum + countMarkdownPreviewNodes(block.tree, MARKDOWN_PREVIEW_BLOCK_MAX_NODES),
        0
      )
    ).toBeLessThanOrEqual(MARKDOWN_PREVIEW_VIEWPORT_MAX_NODES + 40)
    expect(blocks.some((block) => block.oversized)).toBe(true)
  })

  it('finds rendered text beyond the first viewport, including highlighted code and footnotes', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      `# Start\n\n${'Ordinary paragraph.\n\n'.repeat(
        100
      )}\`\`\`javascript\nconst needle = 1\n\`\`\`\n\nLast needle.[^n]\n\n[^n]: Footnote needle\n`
    )
    const result = await engine.search('needle')
    expect(result?.matches).toHaveLength(3)
    expect(result?.matches.every((match) => match.block > 90)).toBe(true)
    expect(await engine.search('missing')).toEqual({ matches: [], truncated: false })
    expect(await engine.search('x'.repeat(2049))).toEqual({ matches: [], truncated: false })
  })

  it('bounds search results and supersedes work when the query changes', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(`${'needle '.repeat(MARKDOWN_PREVIEW_MAX_SEARCH_MATCHES)}\n\nend needle\n`)
    // One oversized paragraph is explicitly unavailable in the rendered preview.
    expect((await engine.search('needle'))?.matches).toHaveLength(1)
    engine.load(`${'needle '.repeat(100)}\n\n${`${'needle '.repeat(100)}\n\n`.repeat(110)}`)
    const pending = engine.search('needle')
    const latest = engine.search('absent')
    expect(await pending).toBeNull()
    expect(await latest).toEqual({ matches: [], truncated: false })
    const capped = await engine.search('needle')
    expect(capped?.matches).toHaveLength(MARKDOWN_PREVIEW_MAX_SEARCH_MATCHES)
    expect(capped?.truncated).toBe(true)
  })
})
