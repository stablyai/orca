import { describe, expect, it } from 'vitest'
import type { Nodes } from 'hast'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import {
  followMarkdownPreviewAnchor,
  markdownPreviewScrollAnchorKey
} from '../viewport/use-markdown-preview-scroll-anchor'
import { parseMarkdownPreviewDocument } from './markdown-preview-document-tree'

function elements(node: Nodes): Nodes[] {
  return [node, ...('children' in node ? node.children.flatMap(elements) : [])]
}

describe('large Markdown preview documents', () => {
  it('invalidates searches on document replacement', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('needle\n\n'.repeat(100))
    const pending = engine.search('needle')
    engine.load('# Replacement')
    expect(await pending).toBeNull()
    expect(await engine.search('needle')).toEqual({ matches: [], truncated: false })
  })

  it.each([
    ['lines are inserted above it', 'S.\n\n## A\n\nRead.\n', 'S.\n\nNew.\n\n## A\n\nRead.\n', 2, 3],
    ['it is edited in place', 'S.\n\n## A\n\nRead.\n', 'S.\n\n## A\n\nRead on.\n', 2, 2],
    ['an identical block above it is edited', 'S.\n\n## A\n\nS.\n', 'Edit.\n\n## A\n\nS.\n', 2, 2],
    [
      'it is edited next to an insertion',
      'A.\n\n\n\nRead.\n\nT.\n',
      'A.\n\nNew.\n\nRead on.\n\nT.\n',
      1,
      2
    ],
    [
      'an identical block is inserted right above it',
      'A.\n\n\n\nRead.\n\nT.\n',
      'A.\n\nRead.\n\nRead.\n\nT.\n',
      1,
      2
    ],
    [
      'blocks change on both sides of it',
      'A.\n\nRead.\n\nT.\n',
      'A.\n\nNew.\n\nRead.\n\nT changed.\n',
      1,
      2
    ],
    // `costarring` and `liquid` share a 32-bit FNV-1a hash.
    [
      'a block with a colliding hash is inserted above it',
      'A.\n\n\n\ncostarring\n\n\n\nT.\n',
      'A.\n\nliquid\n\n\n\ncostarring\n\nT.\n',
      1,
      2
    ]
  ])('keeps the scroll anchor on the block being read when %s', (_, before, after, from, to) => {
    const previous = parseMarkdownPreviewDocument(before).document.blocks
    const next = parseMarkdownPreviewDocument(after).document.blocks
    const anchor = { key: markdownPreviewScrollAnchorKey(previous[from]), offset: 12 }

    expect(followMarkdownPreviewAnchor(anchor, previous, next)).toEqual({
      key: markdownPreviewScrollAnchorKey(next[to]),
      offset: 12
    })
  })

  it('follows an empty-alt image when a new empty-alt image takes its source line', () => {
    const previous = parseMarkdownPreviewDocument('![](kept.png)\n').document.blocks
    const next = parseMarkdownPreviewDocument('![](inserted.png)\n\n![](kept.png)\n').document
      .blocks

    expect(followMarkdownPreviewAnchor({ key: 'source:1:1', offset: 4 }, previous, next)).toEqual({
      key: 'source:3:1',
      offset: 4
    })
  })

  it('preserves raw HTML nesting across Markdown blocks and sanitizes executable HTML', () => {
    const { tree } = parseMarkdownPreviewDocument(
      '<details open>\n<summary>Read</summary>\n\n**Nested**\n\n</details>\n\n<script>alert(1)</script>'
    )
    const nodes = elements(tree)
    expect(nodes.some((node) => node.type === 'element' && node.tagName === 'script')).toBe(false)
    const details = nodes.find((node) => node.type === 'element' && node.tagName === 'details')
    expect(details).toMatchObject({
      properties: { open: true },
      children: expect.arrayContaining([expect.objectContaining({ tagName: 'p' })])
    })
  })

  it('finds code and footnote text in later document blocks', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      `# Start\n\n${'Ordinary paragraph.\n\n'.repeat(
        100
      )}\`\`\`javascript\nconst needle = 1\n\`\`\`\n\nLast needle.[^n]\n\n[^n]: Footnote needle\n`
    )
    const result = await engine.search('needle')
    expect(result?.matches).toHaveLength(3)
    expect(result?.matches.every((match) => match.block > 90)).toBe(true)
  })
})
