import { describe, expect, it } from 'vitest'
import { parseGitBlameIncremental } from './git-blame-incremental-parser'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

// Records arrive out of line order, and a commit's headers appear only on its first record.
const OUTPUT = [
  `${B} 3 3 2`,
  'author Grace Hopper',
  'author-mail <grace@example.com>',
  'author-time 1700000000',
  'author-tz +0000',
  'committer Grace Hopper',
  'summary fix: handle empty input',
  `previous ${A} src/app.ts`,
  'filename src/app.ts',
  `${A} 1 1 2`,
  'author Ada Lovelace',
  'author-mail <ada@example.com>',
  'author-time 1600000000',
  'summary feat: first version',
  'boundary',
  'filename src/app.ts',
  `${A} 5 5 1`,
  'filename src/app.ts',
  ''
].join('\n')

describe('parseGitBlameIncremental', () => {
  it('builds a commit table and line-sorted ranges', () => {
    expect(parseGitBlameIncremental(OUTPUT)).toEqual({
      commits: [
        {
          oid: B,
          author: 'Grace Hopper',
          authorEmail: 'grace@example.com',
          authorTime: 1_700_000_000_000,
          summary: 'fix: handle empty input'
        },
        {
          oid: A,
          author: 'Ada Lovelace',
          authorEmail: 'ada@example.com',
          authorTime: 1_600_000_000_000,
          summary: 'feat: first version'
        }
      ],
      ranges: [1, 2, 1, 3, 2, 0, 5, 1, 1]
    })
  })
})
