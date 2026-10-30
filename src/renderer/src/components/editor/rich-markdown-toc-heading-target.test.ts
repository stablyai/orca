// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildMarkdownTableOfContents, type MarkdownTocItem } from './markdown-table-of-contents'
import { findRichMarkdownTocHeadingTarget } from './rich-markdown-toc-heading-target'

function makeTocItem(
  id: string,
  level: MarkdownTocItem['level'],
  title: string,
  children: MarkdownTocItem[] = []
): MarkdownTocItem {
  return { id, level, title, children }
}

describe('findRichMarkdownTocHeadingTarget', () => {
  it('resolves normalized TOC titles to headings with repeated display whitespace', () => {
    const container = document.createElement('div')
    container.innerHTML = '<h1>Setup   guide</h1><h1>Setup  guide</h1>'
    const items = buildMarkdownTableOfContents('# Setup   guide\n\n# Setup  guide')
    const headings = container.querySelectorAll<HTMLElement>('h1')

    expect(items.map((item) => ({ id: item.id, title: item.title }))).toEqual([
      { id: 'setup-guide', title: 'Setup guide' },
      { id: 'setup-guide-1', title: 'Setup guide' }
    ])
    expect(findRichMarkdownTocHeadingTarget(container, items, items[0].id)).toBe(headings[0])
    expect(findRichMarkdownTocHeadingTarget(container, items, items[1].id)).toBe(headings[1])
  })

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

  it('returns undefined when the requested duplicate occurrence is missing', () => {
    const container = document.createElement('div')
    container.innerHTML = '<h2>Repeat</h2><h2>Other</h2>'
    const items = [makeTocItem('repeat', 2, 'Repeat'), makeTocItem('repeat-1', 2, 'Repeat')]
    expect(findRichMarkdownTocHeadingTarget(container, items, 'repeat-1')).toBeUndefined()
    expect(findRichMarkdownTocHeadingTarget(container, items, 'missing')).toBeUndefined()
  })

  it('finds deep headings that the table of contents exposes', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <h1>Intro</h1>
      <h4>Configure</h4>
      <h5>Options</h5>
    `
    const headings = container.querySelectorAll<HTMLElement>('h1, h4, h5')
    const items = [
      makeTocItem('intro', 1, 'Intro'),
      makeTocItem('configure', 4, 'Configure'),
      makeTocItem('options', 5, 'Options')
    ]

    expect(findRichMarkdownTocHeadingTarget(container, items, 'configure')).toBe(headings[1])
    expect(findRichMarkdownTocHeadingTarget(container, items, 'options')).toBe(headings[2])
  })

  it('keeps duplicate heading navigation aligned with TOC slug order', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <h4>Repeat</h4>
      <h5>Repeat</h5>
    `
    const headings = container.querySelectorAll<HTMLElement>('h4, h5')
    const items = [makeTocItem('repeat', 4, 'Repeat'), makeTocItem('repeat-1', 5, 'Repeat')]

    expect(findRichMarkdownTocHeadingTarget(container, items, 'repeat')).toBe(headings[0])
    expect(findRichMarkdownTocHeadingTarget(container, items, 'repeat-1')).toBe(headings[1])
  })
})
