import { describe, expect, it } from 'vitest'
import { MarkdownHeadingSlugger, slugMarkdownHeading } from './markdown-heading-slug'

describe('markdown heading slugger', () => {
  it('matches GitHub-style punctuation and space handling used by markdown anchors', () => {
    expect(slugMarkdownHeading('A & B')).toBe('a--b')
    expect(slugMarkdownHeading('https://example.com')).toBe('httpsexamplecom')
    expect(slugMarkdownHeading('Keep_under-score')).toBe('keep_under-score')
  })

  it('adds stable duplicate suffixes', () => {
    const slugger = new MarkdownHeadingSlugger()

    expect([slugger.slug('Repeat'), slugger.slug('Repeat'), slugger.slug('Repeat')]).toEqual([
      'repeat',
      'repeat-1',
      'repeat-2'
    ])
  })

  it('can reset duplicate state between render passes', () => {
    const slugger = new MarkdownHeadingSlugger()

    expect(slugger.slug('Repeat')).toBe('repeat')
    expect(slugger.slug('Repeat')).toBe('repeat-1')
    slugger.reset()
    expect(slugger.slug('Repeat')).toBe('repeat')
  })
})
