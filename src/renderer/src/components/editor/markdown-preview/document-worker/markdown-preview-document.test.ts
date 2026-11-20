import { describe, expect, it } from 'vitest'
import type { Nodes } from 'hast'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
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
