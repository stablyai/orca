import { describe, expect, it } from 'vitest'
import {
  parseGitRevListAheadBehindCounts,
  parseGitRevListFirstParentOid
} from './git-rev-list-output'

describe('parseGitRevListAheadBehindCounts', () => {
  it('parses counts surrounded by mixed whitespace', () => {
    expect(parseGitRevListAheadBehindCounts('  12\t3\r\n')).toEqual({
      status: 'ok',
      ahead: 12,
      behind: 3
    })
  })

  it('rejects missing or extra fields', () => {
    expect(parseGitRevListAheadBehindCounts('1\n')).toEqual({
      status: 'unexpected-field-count'
    })
    expect(parseGitRevListAheadBehindCounts('1 2 3\n')).toEqual({
      status: 'unexpected-field-count'
    })
  })

  it('rejects unparseable counts', () => {
    expect(parseGitRevListAheadBehindCounts('1 nope\n')).toEqual({
      status: 'unparseable-counts'
    })
    expect(parseGitRevListAheadBehindCounts('-1 2\n')).toEqual({
      status: 'unparseable-counts'
    })
  })
})

describe('parseGitRevListFirstParentOid', () => {
  it('returns the first parent from rev-list parent output', () => {
    expect(parseGitRevListFirstParentOid('commit-oid parent-oid second-parent\n')).toBe(
      'parent-oid'
    )
  })

  it('returns null for a root commit', () => {
    expect(parseGitRevListFirstParentOid('commit-oid\n')).toBeNull()
  })
})
