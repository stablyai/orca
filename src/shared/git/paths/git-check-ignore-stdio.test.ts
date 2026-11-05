import { describe, expect, it } from 'vitest'
import {
  encodeGitCheckIgnorePaths,
  parseGitCheckIgnorePaths,
  splitGitCheckIgnorePathsByStdinBytes
} from './git-check-ignore-stdio'

describe('git check-ignore stdio', () => {
  it('encodes exact paths as NUL-delimited stdin records', () => {
    expect(encodeGitCheckIgnorePaths(['dist/bundle.js', 'line\nbreak.txt', '-leading.txt'])).toBe(
      'dist/bundle.js\0line\nbreak.txt\0-leading.txt\0'
    )
  })

  it('parses exact paths without treating embedded newlines as records', () => {
    expect(parseGitCheckIgnorePaths('dist/bundle.js\0line\nbreak.txt\0-leading.txt\0')).toEqual([
      'dist/bundle.js',
      'line\nbreak.txt',
      '-leading.txt'
    ])
  })

  it('bounds stdin chunks by encoded bytes without splitting a path', () => {
    expect(splitGitCheckIgnorePathsByStdinBytes(['abcd', 'efgh', 'ijk'], 10)).toEqual([
      ['abcd', 'efgh'],
      ['ijk']
    ])
    expect(splitGitCheckIgnorePathsByStdinBytes(['éé', 'a'], 5)).toEqual([['éé'], ['a']])
  })
})
