import { describe, expect, it } from 'vitest'
import { findTextMatchRanges, isMarkdownPreviewFindShortcut } from './markdown-preview-search'

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
})
