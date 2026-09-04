import { describe, expect, it } from 'vitest'
import {
  blameLineByNumber,
  buildGitBlameArgv,
  formatBlameAnnotation,
  formatBlameRelativeTime,
  GIT_BLAME_HEAD_REVISION,
  isUncommittedBlameOid,
  parseBlamePorcelain
} from './git-blame'

const SAMPLE = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2',
  'author Ada Lovelace',
  'author-mail <ada@example.com>',
  'author-time 1700000000',
  'author-tz +0000',
  'summary Add parser',
  'filename src/git-blame.ts',
  '\texport function parse() {',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2',
  'filename src/git-blame.ts',
  '\t  return []',
  '0000000000000000000000000000000000000000 3 3 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1700000060',
  'summary uncommitted',
  'filename src/git-blame.ts',
  '\t}'
].join('\n')

describe('parseBlamePorcelain', () => {
  it('keeps author metadata across grouped lines and marks the zero oid', () => {
    const lines = parseBlamePorcelain(SAMPLE)
    expect(lines).toEqual([
      {
        line: 1,
        commitOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        author: 'Ada Lovelace',
        authorTime: 1700000000,
        summary: 'Add parser'
      },
      {
        line: 2,
        commitOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        author: 'Ada Lovelace',
        authorTime: 1700000000,
        summary: 'Add parser'
      },
      {
        line: 3,
        commitOid: '0000000000000000000000000000000000000000',
        author: 'Not Committed Yet',
        authorTime: 1700000060,
        summary: 'uncommitted'
      }
    ])
    expect(isUncommittedBlameOid(lines[2]?.commitOid ?? '')).toBe(true)
    expect(blameLineByNumber(lines, 2)?.author).toBe('Ada Lovelace')
    expect(blameLineByNumber(lines, 99)).toBeNull()
  })
})

describe('formatBlameAnnotation', () => {
  it('uses the uncommitted label for a zero oid', () => {
    expect(
      formatBlameAnnotation({
        line: 1,
        commitOid: '0000000000000000000000000000000000000000',
        author: 'Not Committed Yet',
        authorTime: 1,
        summary: 'wip'
      })
    ).toBe('Not Committed Yet')
  })

  it('joins author, relative time, and a clipped summary', () => {
    const annotation = formatBlameAnnotation(
      {
        line: 1,
        commitOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        author: 'Ada',
        authorTime: 1_700_000_000,
        summary: 'x'.repeat(60)
      },
      { uncommittedLabel: 'Not Committed Yet', nowMs: 1_700_000_000 * 1000 + 3_600_000 }
    )
    expect(annotation.startsWith('Ada, ')).toBe(true)
    expect(annotation).toContain('• ')
    expect(annotation.endsWith('…')).toBe(true)
  })
})

describe('formatBlameRelativeTime', () => {
  it('returns an empty string for a missing timestamp', () => {
    expect(formatBlameRelativeTime(0)).toBe('')
  })
})

describe('buildGitBlameArgv', () => {
  it('blames the working tree when no revision is given', () => {
    expect(buildGitBlameArgv('src/a.ts')).toEqual([
      'blame',
      '--encoding=UTF-8',
      '--line-porcelain',
      '-w',
      '--end-of-options',
      '--',
      'src/a.ts'
    ])
  })

  it('places a revision before end-of-options', () => {
    expect(buildGitBlameArgv('src/a.ts', GIT_BLAME_HEAD_REVISION)).toContain(
      GIT_BLAME_HEAD_REVISION
    )
    expect(
      buildGitBlameArgv('src/a.ts', GIT_BLAME_HEAD_REVISION).indexOf(GIT_BLAME_HEAD_REVISION)
    ).toBeLessThan(
      buildGitBlameArgv('src/a.ts', GIT_BLAME_HEAD_REVISION).indexOf('--end-of-options')
    )
  })
})
