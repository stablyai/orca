import { describe, expect, it } from 'vitest'
import {
  isNonAsciiProseBoundary,
  trimFileLinkRangeTrailingNonAsciiProse,
  trimFileLinkTrailingNonAsciiProse
} from './non-ascii-terminal-text-boundary'

describe('isNonAsciiProseBoundary (#15240)', () => {
  it('treats full-width punctuation and ideographic space as prose boundaries', () => {
    expect(isNonAsciiProseBoundary('（'.charCodeAt(0))).toBe(true)
    expect(isNonAsciiProseBoundary('、'.charCodeAt(0))).toBe(true)
    expect(isNonAsciiProseBoundary('。'.charCodeAt(0))).toBe(true)
    expect(isNonAsciiProseBoundary('\u3000'.charCodeAt(0))).toBe(true)
  })

  it('does not treat CJK letters in a path as prose boundaries', () => {
    expect(isNonAsciiProseBoundary('文'.charCodeAt(0))).toBe(false)
    expect(isNonAsciiProseBoundary('档'.charCodeAt(0))).toBe(false)
    expect(isNonAsciiProseBoundary('へ'.charCodeAt(0))).toBe(false)
  })
})

describe('trimFileLinkTrailingNonAsciiProse (file-link mirror of #15240)', () => {
  it.each([
    ['README.mdへ', 'README.md'],
    ['AGENTS.mdに', 'AGENTS.md'],
    ['file.tsです', 'file.ts'],
    ['plans/foo.mdへ', 'plans/foo.md'],
    ['src/foo.ts:12へ', 'src/foo.ts:12'],
    ['src/foo.ts:12:3に', 'src/foo.ts:12:3'],
    ['/Users/me/docs/日本語フォルダ/ファイル.mdへ', '/Users/me/docs/日本語フォルダ/ファイル.md'],
    ['ファイル.md了', 'ファイル.md'],
    // Trailing prose is not always a bare letter run: a particle may be followed by
    // punctuation or ASCII, and CJK brackets close a citation (#15240 boundary set).
    ['plans/foo.mdを(参照)', 'plans/foo.md'],
    ['plans/foo.mdへabc', 'plans/foo.md'],
    ['docs/日本語.md」を', 'docs/日本語.md'],
    ['README.md、次', 'README.md']
  ])('trims non-ASCII letters after an ASCII extension: %s', (input, expected) => {
    expect(trimFileLinkTrailingNonAsciiProse(input)).toBe(expected)
  })

  it.each([
    'README.md',
    'README.md for',
    'file.mdbackup',
    'file.mdBackup',
    'plans/foo.md',
    '/Users/me/docs/日本語フォルダ/ファイル.md',
    'Makefile',
    'src/foo.ts:12:3'
  ])('leaves non-particle text unchanged: %s', (input) => {
    expect(trimFileLinkTrailingNonAsciiProse(input)).toBe(input)
  })

  it('adjusts endIndex when trimming a range', () => {
    const range = {
      text: 'README.mdへ',
      startIndex: 10,
      endIndex: 10 + 'README.mdへ'.length
    }
    expect(trimFileLinkRangeTrailingNonAsciiProse(range)).toEqual({
      text: 'README.md',
      startIndex: 10,
      endIndex: 19
    })
  })
})
