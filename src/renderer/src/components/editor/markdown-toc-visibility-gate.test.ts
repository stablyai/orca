import { describe, expect, it } from 'vitest'
import { selectMarkdownTableOfContents } from './markdown-toc-visibility-gate'

const SAMPLE = '# Intro\n\n## Setup\n\n### Install\n\n## Usage'

describe('selectMarkdownTableOfContents', () => {
  it('builds a real outline through the default builder when open', () => {
    const toc = selectMarkdownTableOfContents(true, SAMPLE)
    expect(toc.map((item) => item.title)).toEqual(['Intro'])
    expect(toc[0]?.children.map((item) => item.title)).toEqual(['Setup', 'Usage'])
  })
})
