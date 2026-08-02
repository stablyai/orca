import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownTableOfContentsPanel } from './MarkdownTableOfContentsPanel'
import type { MarkdownTocItem } from './markdown-table-of-contents'

const sampleItems: MarkdownTocItem[] = [
  {
    id: 'intro',
    level: 1,
    title: 'Intro',
    children: [
      {
        id: 'setup',
        level: 2,
        title: 'Setup',
        children: [
          {
            id: 'install',
            level: 3,
            title: 'Install',
            children: [
              {
                id: 'configure',
                level: 4,
                title: 'Configure',
                children: [
                  {
                    id: 'options',
                    level: 5,
                    title: 'Options',
                    children: []
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
]

describe('MarkdownTableOfContentsPanel', () => {
  it('renders level collapse controls and disclosure buttons', () => {
    const html = renderToStaticMarkup(
      <MarkdownTableOfContentsPanel items={sampleItems} onClose={() => {}} onNavigate={() => {}} />
    )

    expect(html).toContain('Collapse by level')
    expect(html).toContain('Collapse to heading level 1')
    expect(html).toContain('Collapse to heading level 4')
    expect(html).toContain('Expand all heading levels')
    expect(html).toContain('H5')
    expect(html).toContain('Collapse Intro')
    expect(html).toContain('Install')
    expect(html).toContain('Configure')
    expect(html).toContain('Options')
    expect(html).toContain('Intro')
    expect(html).toContain('Setup')
    expect(html).toContain('data-markdown-toc-resize-handle')
    expect(html).toContain('Resize table of contents')
  })
})
