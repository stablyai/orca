import { describe, expect, it } from 'vitest'
import {
  buildMarkdownTableOfContents,
  stripInlineMarkdownForToc
} from './markdown-table-of-contents'

describe('markdown table of contents', () => {
  it('builds a nested h1-h3 outline', () => {
    const toc = buildMarkdownTableOfContents('# Intro\n\n## Setup\n\n### Install\n\n## Usage')

    expect(toc).toEqual([
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
                children: []
              }
            ]
          },
          {
            id: 'usage',
            level: 2,
            title: 'Usage',
            children: []
          }
        ]
      }
    ])
  })

  it('skips front matter and unsupported heading depths', () => {
    const toc = buildMarkdownTableOfContents('---\ntitle: Doc\n---\n# Visible\n#### Hidden')

    expect(toc.map((item) => item.title)).toEqual(['Visible'])
  })

  it('skips headings inside fenced code blocks', () => {
    const toc = buildMarkdownTableOfContents('# Install\n\n```sh\n# not a heading\n```\n\n## Real')

    expect(toc[0].children.map((item) => item.title)).toEqual(['Real'])
  })

  it('includes rendered markdown heading forms', () => {
    const toc = buildMarkdownTableOfContents(
      '# Intro\n\n  ## Indented\n\nSetext *Title*\n---\n\n### https://example.com'
    )

    expect(toc[0].children).toEqual([
      {
        id: 'indented',
        level: 2,
        title: 'Indented',
        children: []
      },
      {
        id: 'setext-title',
        level: 2,
        title: 'Setext Title',
        children: [
          {
            id: 'httpsexamplecom',
            level: 3,
            title: 'https://example.com',
            children: []
          }
        ]
      }
    ])
  })

  it('uses GitHub-compatible duplicate slugs', () => {
    const toc = buildMarkdownTableOfContents('# Repeat\n# Repeat')

    expect(toc.map((item) => item.id)).toEqual(['repeat', 'repeat-1'])
  })

  it('decodes HTML entities before slugging headings', () => {
    const toc = buildMarkdownTableOfContents('# A &amp; B')

    expect(toc[0]).toMatchObject({
      id: 'a--b',
      title: 'A & B'
    })
  })

  it('strips inline markdown from labels', () => {
    expect(stripInlineMarkdownForToc('Use **bold** [links](./x) and [[docs|Docs]]')).toBe(
      'Use bold links and Docs'
    )
  })
})
