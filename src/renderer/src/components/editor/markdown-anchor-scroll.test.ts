// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { scrollToAnchorInEditor } from './markdown-anchor-scroll'
import { parseMarkdownPreviewDocument } from './markdown-preview-document-tree'

it.each([['Release ½'], ['Use ①', 'Use ²'], ['New \u{1e4d0}'], ['Café 中文', 'Café 中文']])(
  'resolves preview anchors for rich headings: %j',
  (...titles) => {
    const { document: preview } = parseMarkdownPreviewDocument(
      titles.map((title) => `## ${title}`).join('\n\n')
    )
    const root = document.createElement('div')
    const headings = titles.map((title) => {
      const heading = document.createElement('h2')
      heading.textContent = title
      root.append(heading)
      return vi.spyOn(heading, 'scrollIntoView').mockImplementation(() => {})
    })

    for (const [index, anchor] of preview.blocks.flatMap((block) => block.anchors).entries()) {
      headings.forEach((scroll) => scroll.mockClear())
      scrollToAnchorInEditor(root, encodeURIComponent(anchor))
      expect(headings.map((scroll) => scroll.mock.calls.length)).toEqual(
        headings.map((_, headingIndex) => Number(index === headingIndex))
      )
    }
  }
)
