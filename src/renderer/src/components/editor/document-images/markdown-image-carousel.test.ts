import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from '../rich-markdown/code-blocks/rich-markdown-lowlight'
import { parseMarkdownImageCarousel } from './markdown-image-carousel'

const slides = [
  '![Map](</work/styles/map one.png> "Map caption")',
  '<!-- slide -->',
  '![Lesson](./lesson.png)'
].join('\n')

describe('Markdown image carousel', () => {
  it('reads one Markdown image per slide, including relative and absolute destinations', () => {
    expect(parseMarkdownImageCarousel(slides.replaceAll('\n', '\r\n'))).toEqual([
      { src: '/work/styles/map one.png', alt: 'Map', title: 'Map caption' },
      { src: './lesson.png', alt: 'Lesson' }
    ])
    expect(parseMarkdownImageCarousel('![Map](C:/work/map.png)')).toEqual([
      { src: 'C:/work/map.png', alt: 'Map' }
    ])
  })

  it('falls back to source for non-image content or a blocked URL', () => {
    expect(parseMarkdownImageCarousel(`${slides}\nOther content`)).toBeNull()
    expect(parseMarkdownImageCarousel('![Invalid](javascript:alert(1))')).toBeNull()
    expect(parseMarkdownImageCarousel('![Invalid](unsupported&colon;image.png)')).toBeNull()
  })

  it('decodes Markdown character references in image attributes', () => {
    expect(parseMarkdownImageCarousel('![A &amp; B](./a&amp;b.png "A &amp; B")')).toEqual([
      { src: './a&b.png', alt: 'A & B', title: 'A & B' }
    ])
  })

  it('serializes the Antigravity fence and slide separator after rich parsing', () => {
    const markdown = ['````carousel', slides, '````'].join('\n')
    const manager = new MarkdownManager({
      extensions: [StarterKit.configure({ codeBlock: false }), RichMarkdownCodeBlockLowlight]
    })

    expect(manager.serialize(manager.parse(markdown))).toBe(markdown)
  })
})
