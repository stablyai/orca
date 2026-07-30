import { describe, expect, it } from 'vitest'
import { GIT_STASH_LIST_ARGS, parseGitStashList, parseStashRefIndex } from './git-stash-list-output'

function record(ref: string, oid: string, createdAt: string, subject: string): string {
  return `${ref}\0${oid}\0${createdAt}\0${subject}\0`
}

const OID_A = 'b6ca323068fc18c2133f1cc3eb3c2a95e127de7d'
const OID_B = '4f1c9d2ab7e5f30918c6d4b2a8e7f1039c5d6e2b'

describe('GIT_STASH_LIST_ARGS', () => {
  it('requests a NUL-delimited custom format', () => {
    expect(GIT_STASH_LIST_ARGS).toEqual(['stash', 'list', '-z', '--format=%gd%x00%H%x00%ct%x00%gs'])
  })
})

describe('parseGitStashList', () => {
  it('parses a NUL-terminated listing', () => {
    const stdout =
      record('stash@{0}', OID_A, '1785416506', 'WIP on main: dcd7952 init: base') +
      record('stash@{1}', OID_B, '1785410000', 'On fix/foo: parked')

    expect(parseGitStashList(stdout)).toEqual([
      {
        ref: 'stash@{0}',
        index: 0,
        commitOid: OID_A,
        createdAtSeconds: 1785416506,
        subject: 'WIP on main: dcd7952 init: base'
      },
      {
        ref: 'stash@{1}',
        index: 1,
        commitOid: OID_B,
        createdAtSeconds: 1785410000,
        subject: 'On fix/foo: parked'
      }
    ])
  })

  it('returns no entries for a repo with no stashes', () => {
    // Why: `git stash list` exits 0 with empty stdout when refs/stash is absent.
    expect(parseGitStashList('')).toEqual([])
  })

  it('keeps colons inside the subject intact', () => {
    // Why: the default `%gd: %gs` format is unparseable precisely because the
    // subject carries its own colons — this is the regression that motivated NUL.
    const entries = parseGitStashList(
      record('stash@{0}', OID_A, '1785416506', 'WIP on main: dcd7952 fix: parse a:b')
    )
    expect(entries[0].subject).toBe('WIP on main: dcd7952 fix: parse a:b')
  })

  it('strips the trailing newline when git ignored -z', () => {
    const stdout = `stash@{0}\x00${OID_A}\x001785416506\x00WIP on main: subject\n`
    expect(parseGitStashList(stdout)).toEqual([
      {
        ref: 'stash@{0}',
        index: 0,
        commitOid: OID_A,
        createdAtSeconds: 1785416506,
        subject: 'WIP on main: subject'
      }
    ])
  })

  it('strips a CRLF subject terminator', () => {
    const stdout = `stash@{0}\x00${OID_A}\x001785416506\x00WIP on main: subject\r\n`
    expect(parseGitStashList(stdout)[0].subject).toBe('WIP on main: subject')
  })

  it('drops a truncated trailing record instead of emitting empty fields', () => {
    const stdout = `${record('stash@{0}', OID_A, '1785416506', 'kept')}stash@{1}\x00${OID_B}\x00`
    expect(parseGitStashList(stdout).map((entry) => entry.ref)).toEqual(['stash@{0}'])
  })

  it('skips records whose ref or oid git could not fill in', () => {
    const stdout =
      record('%gd', 'not-an-oid', '1785416506', 'bogus') +
      record('stash@{0}', OID_A, '1785416506', 'real')
    expect(parseGitStashList(stdout).map((entry) => entry.ref)).toEqual(['stash@{0}'])
  })

  it('falls back to 0 for an unparseable timestamp rather than dropping the entry', () => {
    const entries = parseGitStashList(record('stash@{0}', OID_A, '%ct', 'subject'))
    expect(entries).toEqual([
      { ref: 'stash@{0}', index: 0, commitOid: OID_A, createdAtSeconds: 0, subject: 'subject' }
    ])
  })

  it('accepts an empty subject', () => {
    expect(parseGitStashList(record('stash@{0}', OID_A, '1785416506', ''))[0].subject).toBe('')
  })

  it('parses double-digit stash indexes', () => {
    expect(parseGitStashList(record('stash@{12}', OID_A, '1785416506', 'x'))[0].index).toBe(12)
  })
})

describe('parseStashRefIndex', () => {
  it.each(['stash@{0}', 'stash@{7}', 'stash@{104}'])('accepts %s', (ref) => {
    expect(parseStashRefIndex(ref)).toBe(Number.parseInt(/\{(\d+)\}/.exec(ref)![1], 10))
  })

  it.each([
    'stash@{-1}',
    'stash@{}',
    'stash@{0}extra',
    ' stash@{0}',
    'refs/stash',
    'HEAD',
    '--all',
    ''
  ])('rejects %j', (ref) => {
    expect(parseStashRefIndex(ref)).toBeNull()
  })
})
