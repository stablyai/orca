import { describe, expect, it } from 'vitest'
import {
  buildMarkdownHeadingSections,
  type MarkdownHeadingSection
} from './markdown-heading-outline'

type Outline = { title: string; lines: [number, number]; children?: Outline[] }

function outline(sections: MarkdownHeadingSection[]): Outline[] {
  return sections.map((section) => ({
    title: section.title,
    lines: [section.startLine, section.endLine],
    ...(section.children.length > 0 ? { children: outline(section.children) } : {})
  }))
}

describe('buildMarkdownHeadingSections', () => {
  it('nests sections by level and ends each before the next same-or-higher heading', () => {
    const lines = ['# A', 'text', '## B', '### C', 'x', '## D', '# E', 'tail']
    expect(outline(buildMarkdownHeadingSections(lines))).toEqual([
      {
        title: 'A',
        lines: [1, 6],
        children: [
          { title: 'B', lines: [3, 5], children: [{ title: 'C', lines: [4, 5] }] },
          { title: 'D', lines: [6, 6] }
        ]
      },
      { title: 'E', lines: [7, 8] }
    ])
  })

  it('ignores fenced code, front matter, and thematic breaks but reads setext headings', () => {
    const lines = [
      '---',
      'title: # not a heading',
      '---',
      '````md',
      '# fenced',
      '```',
      '````',
      'Setext Title',
      '===',
      '',
      '---',
      '- item',
      '---',
      '## Closed ##'
    ]
    expect(outline(buildMarkdownHeadingSections(lines))).toEqual([
      { title: 'Setext Title', lines: [8, 14], children: [{ title: 'Closed', lines: [14, 14] }] }
    ])
  })
})
