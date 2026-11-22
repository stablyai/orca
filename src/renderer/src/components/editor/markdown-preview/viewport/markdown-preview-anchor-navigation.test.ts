// @vitest-environment happy-dom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseMarkdownPreviewDocument } from '../document-worker/markdown-preview-document-tree'
import { MarkdownPreviewBody } from '../render-tree/MarkdownPreviewBody'
import {
  findMarkdownPreviewAnchorElement,
  resolveMarkdownPreviewAnchorId
} from './markdown-preview-anchor-navigation'

function renderPreview(content: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    createElement(MarkdownPreviewBody, { content, components: {} })
  )
  return host
}

describe('markdown preview HTML anchors', () => {
  it.each([
    {
      name: 'authored id through the sanitizer prefix',
      content: '[Go to section](#section)\n\n<a id="section"></a>\n',
      hash: 'section',
      expectedId: 'user-content-section'
    },
    {
      name: 'authored id that already has the prefix',
      content: '[Go to section](#user-content-section)\n\n<a id="user-content-section"></a>\n',
      hash: 'user-content-section',
      expectedId: 'user-content-user-content-section'
    }
  ])('resolves $name', ({ content, hash, expectedId }) => {
    expect(findMarkdownPreviewAnchorElement(renderPreview(content), hash)?.id).toBe(expectedId)
  })

  it('reaches a punctuation-only heading whose slug is empty in both preview paths', () => {
    const content = '## !!!\n'
    expect(findMarkdownPreviewAnchorElement(renderPreview(content), '')?.tagName).toBe('H2')
    const { document } = parseMarkdownPreviewDocument(content)
    const anchors = document.blocks.flatMap((block) => block.anchors)
    expect(resolveMarkdownPreviewAnchorId('', (id) => anchors.includes(id))).toBe('')
  })

  it('prefers a heading slug over an authored id with the same name', () => {
    const preview = renderPreview('[Go to section](#section)\n\n<a id="section"></a>\n## Section\n')
    const target = findMarkdownPreviewAnchorElement(preview, 'section')
    expect(target?.id).toBe('section')
    expect(target?.tagName).toBe('H2')
  })

  it('resolves an authored id from the large-document anchor list', () => {
    const { document } = parseMarkdownPreviewDocument(
      '[Go to section](#section)\n\n<h2 id="section">Section</h2>\n'
    )
    const anchors = document.blocks.flatMap((block) => block.anchors)
    expect(anchors).toContain('user-content-section')
    expect(resolveMarkdownPreviewAnchorId('section', (id) => anchors.includes(id))).toBe(
      'user-content-section'
    )
  })

  it('resolves footnote references and back-references in both preview paths', () => {
    const content = 'Text[^n]\n\n[^n]: Note\n'
    const preview = renderPreview(content)
    const hashes = [...preview.querySelectorAll('a[href^="#"]')].map((link) =>
      (link.getAttribute('href') ?? '').slice(1)
    )
    expect(hashes).toEqual(['user-content-fn-n', 'user-content-fnref-n'])
    const expected = ['user-content-user-content-fn-n', 'user-content-user-content-fnref-n']
    expect(hashes.map((hash) => findMarkdownPreviewAnchorElement(preview, hash)?.id)).toEqual(
      expected
    )

    const { document } = parseMarkdownPreviewDocument(content)
    const anchors = new Set(document.blocks.flatMap((block) => block.anchors))
    expect(
      hashes.map((hash) => resolveMarkdownPreviewAnchorId(hash, (id) => anchors.has(id)))
    ).toEqual(expected)
  })
})
