// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { MarkdownTocItem } from './markdown-table-of-contents'
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
