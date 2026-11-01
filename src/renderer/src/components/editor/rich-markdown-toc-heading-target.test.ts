// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildMarkdownTableOfContents } from './markdown-table-of-contents'

import { findRichMarkdownTocHeadingTarget } from './rich-markdown-toc-heading-target'

describe('findRichMarkdownTocHeadingTarget', () => {
  it('uses image alt text inside node views and preserves duplicate occurrences', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <h1>Before <span contenteditable="false"><img alt="Badge"></span> after</h1>
      <h1>Before <span contenteditable="false"><img alt="Other"></span> after</h1>
      <h1>Before <span contenteditable="false"><img alt="Badge"></span> after</h1>
    `
    const items = buildMarkdownTableOfContents(
      '# Before ![Badge](a.png) after\n\n# Before ![Other](b.png) after\n\n# Before ![Badge](c.png) after'
    )
    const headings = container.querySelectorAll<HTMLElement>('h1')

    for (const [index, item] of items.entries()) {
      expect(findRichMarkdownTocHeadingTarget(container, items, item.id)).toBe(headings[index])
    }
  })

  it('matches document-link aliases alongside plain and literal headings with the same label', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <h1>Alias</h1>
      <h1><span data-doc-link-target="Target" data-doc-link-label="Alias">Alias</span></h1>
      <h1><span data-doc-link-target="Other" data-doc-link-label="Alias">Alias</span></h1>
      <h1><code>[[Target|Alias]]</code></h1>
      <h1><span data-doc-link-target="Target">Target</span></h1>
    `
    const items = buildMarkdownTableOfContents(
      '# Alias\n\n# [[ Target | Alias ]]\n\n# [[Other|Alias]]\n\n# `[[Target|Alias]]`\n\n# [[Target]]'
    )
    const headings = container.querySelectorAll<HTMLElement>('h1')

    for (const [index, item] of items.entries()) {
      expect(findRichMarkdownTocHeadingTarget(container, items, item.id)).toBe(headings[index])
    }
  })
})
