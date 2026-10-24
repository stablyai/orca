import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { SearchResult } from '../../../../shared/code-search-types'
import { collectMarkdownBacklinks, markdownBacklinkSearchOptions } from './markdown-backlinks'

function doc(relativePath: string): MarkdownDocument {
  const basename = relativePath.split('/').pop() ?? relativePath
  return {
    filePath: `/repo/${relativePath}`,
    relativePath,
    basename,
    name: basename.replace(/\.(md|mdx|markdown)$/, '')
  }
}

function search(hits: Record<string, string[]>): SearchResult {
  const files = Object.entries(hits).map(([relativePath, lines]) => ({
    filePath: `/repo/${relativePath}`,
    relativePath,
    matches: lines.map((lineContent, index) => ({
      line: index + 1,
      column: 1,
      matchLength: 1,
      lineContent
    }))
  }))
  return { files, totalMatches: files.length, truncated: false }
}

const target = doc('docs/guide.md')
const documents = [target, doc('notes/a.md'), doc('notes/b.md'), doc('other/guide.md'), doc('c.md')]

describe('collectMarkdownBacklinks', () => {
  it('keeps wiki links and relative Markdown links that resolve to the note', () => {
    const backlinks = collectMarkdownBacklinks(
      target,
      documents,
      search({
        'notes/a.md': ['See [[docs/guide|the guide]] first.', 'Plain mention of guide only.'],
        'notes/b.md': ['Read [this](../docs/guide.md#setup).'],
        'c.md': ['[[docs/guide#Install]] and [again](./docs/guide.md)']
      })
    )
    expect(backlinks.map(({ source, line }) => [source.relativePath, line])).toEqual([
      ['c.md', 1],
      ['notes/a.md', 1],
      ['notes/b.md', 1]
    ])
  })

  it('ignores links to a same-named note elsewhere, external URLs and the note itself', () => {
    const backlinks = collectMarkdownBacklinks(
      target,
      documents,
      search({
        'notes/a.md': ['[[other/guide]] and [web](https://example.com/docs/guide.md)'],
        'docs/guide.md': ['[[docs/guide]] links to itself']
      })
    )
    expect(backlinks).toEqual([])
  })

  it('handles encoded, angle-bracket, titled, escaped-pipe and differently cased links', () => {
    const spaced = doc('notes/my note.md')
    const backlinks = collectMarkdownBacklinks(
      spaced,
      [...documents, spaced],
      search({
        'notes/a.md': [
          '[x](my%20note.md)',
          "[x](<my note.md> 'Title')",
          '| [[notes/my note\\|alias]] |',
          '[x](<./My Note.md>)'
        ]
      })
    )
    expect(backlinks.map(({ line }) => line)).toEqual([1, 2, 3, 4])
  })

  it('does not resolve an ambiguous bare name', () => {
    expect(
      collectMarkdownBacklinks(target, documents, search({ 'notes/a.md': ['[[guide]]'] }))
    ).toEqual([])
  })
})

describe('markdownBacklinkSearchOptions', () => {
  it('searches Markdown files for the note name, case-insensitively', () => {
    expect(markdownBacklinkSearchOptions(doc('a b.md'), '/repo').query).toBe('a b|a%20b')
    expect(markdownBacklinkSearchOptions(target, '/repo')).toMatchObject({
      query: 'guide',
      rootPath: '/repo',
      caseSensitive: false,
      includePattern: '*.md,*.mdx,*.markdown'
    })
  })
})
