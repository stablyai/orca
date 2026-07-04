import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES,
  findTextMatchRanges,
  isMarkdownPreviewFindShortcut,
  isMarkdownPreviewReplaceShortcut,
  isMarkdownPreviewSearchQueryTooLarge
} from './markdown-preview-search'

describe('isMarkdownPreviewFindShortcut', () => {
  it('uses Cmd on macOS', () => {
    expect(
      isMarkdownPreviewFindShortcut(
        {
          key: 'f',
          code: 'KeyF',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false
        },
        'darwin'
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewFindShortcut(
        {
          key: 'f',
          code: 'KeyF',
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: false
        },
        'darwin'
      )
    ).toBe(false)
  })

  it('uses Ctrl on non-macOS platforms', () => {
    expect(
      isMarkdownPreviewFindShortcut(
        {
          key: 'f',
          code: 'KeyF',
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: false
        },
        'linux'
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewFindShortcut(
        {
          key: 'f',
          code: 'KeyF',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false
        },
        'linux'
      )
    ).toBe(false)
  })
})

describe('isMarkdownPreviewReplaceShortcut', () => {
  it('uses Cmd+Option+F on macOS', () => {
    expect(
      isMarkdownPreviewReplaceShortcut(
        {
          key: 'f',
          code: 'KeyF',
          metaKey: true,
          ctrlKey: false,
          altKey: true,
          shiftKey: false
        },
        'darwin'
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewReplaceShortcut(
        {
          key: 'h',
          code: 'KeyH',
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: false
        },
        'darwin'
      )
    ).toBe(false)
  })

  it('uses Ctrl+H on non-macOS platforms', () => {
    expect(
      isMarkdownPreviewReplaceShortcut(
        {
          key: 'h',
          code: 'KeyH',
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: false
        },
        'linux'
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewReplaceShortcut(
        {
          key: 'f',
          code: 'KeyF',
          metaKey: true,
          ctrlKey: false,
          altKey: true,
          shiftKey: false
        },
        'linux'
      )
    ).toBe(false)
  })
})

describe('findTextMatchRanges', () => {
  it('finds case-insensitive literal matches', () => {
    expect(findTextMatchRanges('Alpha beta ALPHA', 'alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 }
    ])
  })

  it('skips overlapping matches so highlights remain stable per text node', () => {
    expect(findTextMatchRanges('ababa', 'aba')).toEqual([{ start: 0, end: 3 }])
  })

  it('maps locale-lowercase search matches back to original text offsets', () => {
    const ranges = findTextMatchRanges('İstanbul', 'stan')

    expect(ranges).toEqual([{ start: 1, end: 5 }])
    expect(ranges.map((range) => 'İstanbul'.slice(range.start, range.end))).toEqual(['stan'])
  })

  it('returns no matches for an empty query', () => {
    expect(findTextMatchRanges('Alpha beta', '')).toEqual([])
  })

  it('matches only same-case occurrences when matchCase is set', () => {
    expect(findTextMatchRanges('Alpha beta ALPHA alpha', 'alpha', { matchCase: true })).toEqual([
      { start: 17, end: 22 }
    ])
  })

  it('restricts matches to whole words when wholeWord is set', () => {
    expect(findTextMatchRanges('cat category scatter cat', 'cat', { wholeWord: true })).toEqual([
      { start: 0, end: 3 },
      { start: 21, end: 24 }
    ])
  })

  it('treats underscore and digits as word characters for whole-word matching', () => {
    expect(findTextMatchRanges('id id_2 (id)', 'id', { wholeWord: true })).toEqual([
      { start: 0, end: 2 },
      { start: 9, end: 11 }
    ])
  })

  it('checks whole-word boundaries around astral letters by code point', () => {
    const text = '𐐀cat cat𐐀 cat'

    expect(findTextMatchRanges(text, 'cat', { wholeWord: true })).toEqual([{ start: 12, end: 15 }])
  })

  it('combines matchCase and wholeWord constraints', () => {
    expect(
      findTextMatchRanges('Cat cat catalog', 'cat', { matchCase: true, wholeWord: true })
    ).toEqual([{ start: 4, end: 7 }])
  })

  it('rejects oversized pasted queries before indexing preview text', () => {
    const oversizedQuery = 'secret-preview-search'.repeat(MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES)
    const throwingText = {
      [Symbol.iterator](): IterableIterator<string> {
        throw new Error('oversized markdown preview searches must not scan text')
      }
    } as string

    expect(isMarkdownPreviewSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(findTextMatchRanges(throwingText, oversizedQuery)).toEqual([])
  })
})
