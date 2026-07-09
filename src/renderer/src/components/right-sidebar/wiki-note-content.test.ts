import { describe, expect, it } from 'vitest'
import {
  prepareWikiNoteForDisplay,
  stripFrontmatter,
  wikilinksToMarkdownLinks
} from './wiki-note-content'

describe('stripFrontmatter', () => {
  it('removes a leading frontmatter block', () => {
    expect(stripFrontmatter('---\ntags:\n  - a\n---\n# Home')).toBe('# Home')
  })

  it('leaves content without frontmatter unchanged', () => {
    expect(stripFrontmatter('# Home\n\nSome text')).toBe('# Home\n\nSome text')
  })

  it('does not strip a thematic break in the middle of the body', () => {
    const content = '# Home\n\nIntro\n\n---\n\nMore text'
    expect(stripFrontmatter(content)).toBe(content)
  })
})

describe('wikilinksToMarkdownLinks', () => {
  it('converts a bare wikilink', () => {
    expect(wikilinksToMarkdownLinks('[[Feature]]')).toBe('[Feature](Feature)')
  })

  it('converts a wikilink with a custom label', () => {
    expect(wikilinksToMarkdownLinks('[[Feature|Nice label]]')).toBe('[Nice label](Feature)')
  })

  it('converts a wikilink with an anchor', () => {
    expect(wikilinksToMarkdownLinks('[[Feature#section]]')).toBe('[Feature](Feature)')
  })

  it('leaves existing markdown links untouched', () => {
    expect(wikilinksToMarkdownLinks('[x](y.md)')).toBe('[x](y.md)')
  })
})

describe('prepareWikiNoteForDisplay', () => {
  it('strips frontmatter and converts wikilinks', () => {
    const content = '---\ntags:\n  - a\n---\nSee [[Feature]] for details.'
    expect(prepareWikiNoteForDisplay(content)).toBe('See [Feature](Feature) for details.')
  })
})
