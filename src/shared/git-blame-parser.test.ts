import { describe, expect, it } from 'vitest'
import { parseBlameOutput } from './git-blame-parser'

describe('parseBlameOutput', () => {
  it('parses first and repeated commit blocks', () => {
    const sha1 = 'a'.repeat(40)
    const sha2 = 'b'.repeat(40)
    const output = [
      `${sha1} 1 1 2`,
      'author Ada',
      'author-mail <ada@example.com>',
      'author-time 1700000000',
      'author-tz +0800',
      'committer Ada',
      'committer-mail <ada@example.com>',
      'committer-time 1700000000',
      'committer-tz +0800',
      'summary First commit',
      'filename src/a.ts',
      '\tconst a = 1',
      `${sha1} 2 2`,
      '\tconst b = 2',
      `${sha2} 1 3 1`,
      'author Bo',
      'author-mail <bo@example.com>',
      'author-time 1700000100',
      'author-tz +0800',
      'committer Bo',
      'committer-mail <bo@example.com>',
      'committer-time 1700000100',
      'committer-tz +0800',
      'summary Second commit',
      'filename src/a.ts',
      '\tconst c = 3'
    ].join('\n')

    expect(parseBlameOutput(output)).toEqual([
      {
        sha: sha1,
        shortSha: sha1.slice(0, 7),
        author: 'Ada',
        authorTime: 1700000000,
        summary: 'First commit'
      },
      {
        sha: sha1,
        shortSha: sha1.slice(0, 7),
        author: 'Ada',
        authorTime: 1700000000,
        summary: 'First commit'
      },
      {
        sha: sha2,
        shortSha: sha2.slice(0, 7),
        author: 'Bo',
        authorTime: 1700000100,
        summary: 'Second commit'
      }
    ])
  })

  it('returns null for uncommitted lines', () => {
    const output = [
      `${'0'.repeat(40)} 1 1 1`,
      'author Not Committed Yet',
      'author-mail <not.committed.yet>',
      'author-time 1700000000',
      'author-tz +0800',
      'committer Not Committed Yet',
      'committer-mail <not.committed.yet>',
      'committer-time 1700000000',
      'committer-tz +0800',
      'summary',
      'filename src/a.ts',
      '\tconst fresh = true'
    ].join('\n')

    expect(parseBlameOutput(output)).toEqual([null])
  })
})
