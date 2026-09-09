import { describe, expect, it } from 'vitest'
import { isGitStashRef, parseGitStashFiles, parseGitStashList } from './git-stash'

describe('git stash parsing', () => {
  it('parses bounded stash summaries', () => {
    const output = [
      'stash@{0}',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'Zoë',
      'z@example.com',
      '1700000000',
      'WIP on main: test'
    ].join('\0').concat('\n')
    expect(parseGitStashList(output)).toEqual([
      {
        ref: 'stash@{0}',
        commitId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        author: 'Zoë',
        email: 'z@example.com',
        timestamp: 1700000000,
        summary: 'WIP on main: test'
      }
    ])
  })

  it('parses renamed and ordinary files', () => {
    expect(parseGitStashFiles('M\0src/a.ts\0R100\0old.ts\0new.ts\0')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R100', oldPath: 'old.ts', path: 'new.ts' }
    ])
  })

  it('rejects revisions and malicious refs', () => {
    expect(isGitStashRef('stash@{12}')).toBe(true)
    expect(isGitStashRef('--help')).toBe(false)
    expect(isGitStashRef('HEAD')).toBe(false)
  })
})
