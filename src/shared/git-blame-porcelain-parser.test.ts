import { describe, expect, it } from 'vitest'
import { findGitBlameHunkForLine, parseGitBlamePorcelain } from './git-blame-porcelain-parser'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const UNCOMMITTED = '0'.repeat(40)

function commitHeaders(sha: string, author: string, time: number, summary: string): string[] {
  return [
    `author ${author}`,
    `author-mail <${author.toLowerCase()}@example.com>`,
    `author-time ${time}`,
    'author-tz +0000',
    `committer ${author}`,
    `committer-mail <${author.toLowerCase()}@example.com>`,
    `committer-time ${time}`,
    'committer-tz +0000',
    `summary ${summary}`,
    sha === SHA_A ? 'boundary' : `previous ${SHA_A} file.ts`,
    'filename file.ts'
  ]
}

describe('parseGitBlamePorcelain', () => {
  it('merges consecutive lines per commit and keeps metadata from the first occurrence', () => {
    const stdout = [
      `${SHA_A} 1 1 2`,
      ...commitHeaders(SHA_A, 'Alice', 1_700_000_000, 'initial import'),
      '\tline one',
      `${SHA_A} 2 2`,
      '\tline two',
      `${SHA_B} 3 3 1`,
      ...commitHeaders(SHA_B, 'Bob', 1_710_000_000, 'fix: author 12 3 lookalike'),
      '\tauthor-time 5',
      `${SHA_A} 3 4 1`,
      'filename file.ts',
      '\tline four',
      ''
    ].join('\n')

    const result = parseGitBlamePorcelain(stdout)

    expect(result.hunks).toEqual([
      { sha: SHA_A, startLine: 1, lineCount: 2 },
      { sha: SHA_B, startLine: 3, lineCount: 1 },
      { sha: SHA_A, startLine: 4, lineCount: 1 }
    ])
    expect(result.commits[SHA_A]).toEqual({
      sha: SHA_A,
      author: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 1_700_000_000_000,
      summary: 'initial import',
      uncommitted: false
    })
    expect(result.commits[SHA_B]).toMatchObject({
      author: 'Bob',
      authorTime: 1_710_000_000_000,
      summary: 'fix: author 12 3 lookalike'
    })
  })

  it('flags the all-zero object id as uncommitted', () => {
    const stdout = [
      `${UNCOMMITTED} 1 1 1`,
      'author External file (--contents)',
      'author-mail <external.file>',
      'author-time 1700000000',
      'summary Version of file.ts from -',
      'filename file.ts',
      '\tnew line'
    ].join('\n')

    expect(parseGitBlamePorcelain(stdout).commits[UNCOMMITTED]?.uncommitted).toBe(true)
  })

  it('returns no hunks for empty output', () => {
    expect(parseGitBlamePorcelain('')).toEqual({ commits: {}, hunks: [] })
  })
})

describe('findGitBlameHunkForLine', () => {
  const hunks = [
    { sha: SHA_A, startLine: 1, lineCount: 2 },
    { sha: SHA_B, startLine: 3, lineCount: 5 },
    { sha: SHA_A, startLine: 8, lineCount: 1 }
  ]

  it.each([
    [1, SHA_A],
    [2, SHA_A],
    [3, SHA_B],
    [7, SHA_B],
    [8, SHA_A]
  ])('finds line %i in its hunk', (line, sha) => {
    expect(findGitBlameHunkForLine(hunks, line)?.sha).toBe(sha)
  })

  it('returns null outside the blamed range', () => {
    expect(findGitBlameHunkForLine(hunks, 0)).toBeNull()
    expect(findGitBlameHunkForLine(hunks, 9)).toBeNull()
  })
})
