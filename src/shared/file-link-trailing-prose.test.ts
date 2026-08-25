import { describe, expect, it } from 'vitest'
import {
  trimFileLinkRangeTrailingNonAsciiLetters,
  trimFileLinkTrailingNonAsciiLetters
} from './file-link-trailing-prose'

describe('trimFileLinkTrailingNonAsciiLetters', () => {
  it.each([
    ['README.md로', 'README.md'],
    ['AGENTS.md에', 'AGENTS.md'],
    ['file.tsです', 'file.ts'],
    ['plans/foo.md로', 'plans/foo.md'],
    ['src/foo.ts:12로', 'src/foo.ts:12'],
    ['src/foo.ts:12:3에', 'src/foo.ts:12:3'],
    ['/Users/me/docs/한글폴더/파일.md로', '/Users/me/docs/한글폴더/파일.md'],
    ['파일.md了', '파일.md']
  ])('trims non-ASCII letters after an ASCII extension: %s', (input, expected) => {
    expect(trimFileLinkTrailingNonAsciiLetters(input)).toBe(expected)
  })

  it.each([
    'README.md',
    'README.md for',
    'file.mdbackup',
    'file.mdBackup',
    'plans/foo.md',
    '/Users/me/docs/한글폴더/파일.md',
    'Makefile',
    'src/foo.ts:12:3'
  ])('leaves non-particle text unchanged: %s', (input) => {
    expect(trimFileLinkTrailingNonAsciiLetters(input)).toBe(input)
  })

  it('adjusts endIndex when trimming a range', () => {
    const range = {
      text: 'README.md로',
      startIndex: 10,
      endIndex: 10 + 'README.md로'.length
    }
    expect(trimFileLinkRangeTrailingNonAsciiLetters(range)).toEqual({
      text: 'README.md',
      startIndex: 10,
      endIndex: 19
    })
  })
})
