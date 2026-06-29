import { describe, expect, it, vi } from 'vitest'
import { selectMarkdownTableOfContents } from './markdown-toc-visibility-gate'

const SAMPLE = '# Intro\n\n## Setup\n\n### Install\n\n## Usage'

describe('selectMarkdownTableOfContents', () => {
  it('does not parse markdown when the panel is closed', () => {
    const build = vi.fn(() => [])
    const result = selectMarkdownTableOfContents(false, SAMPLE, build)
    expect(build).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('returns a stable empty-array reference across content changes while closed', () => {
    // Why: a fresh [] every call would change the memo's value and force the
    // downstream TOC panel/handlers to re-render even though nothing is shown.
    const first = selectMarkdownTableOfContents(false, 'a')
    const second = selectMarkdownTableOfContents(false, 'a\nb')
    expect(first).toBe(second)
  })

  it('parses the document when the panel is open', () => {
    const build = vi.fn(() => [{ id: 'x', level: 1 as const, title: 'X', children: [] }])
    const result = selectMarkdownTableOfContents(true, SAMPLE, build)
    expect(build).toHaveBeenCalledExactlyOnceWith(SAMPLE)
    expect(result).toHaveLength(1)
  })

  it('builds a real outline through the default builder when open', () => {
    const toc = selectMarkdownTableOfContents(true, SAMPLE)
    expect(toc.map((item) => item.title)).toEqual(['Intro'])
    expect(toc[0]?.children.map((item) => item.title)).toEqual(['Setup', 'Usage'])
  })
})
