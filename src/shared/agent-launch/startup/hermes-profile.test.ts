import { describe, expect, it } from 'vitest'
import {
  hermesProfileRoot,
  hermesStateDbProfile,
  hermesStateDbProfileArgs,
  readHermesProfileName
} from './hermes-profile'

describe('readHermesProfileName', () => {
  it('keeps a named profile id', () => {
    expect(readHermesProfileName('work')).toBe('work')
    expect(readHermesProfileName(' work ')).toBe('work')
    expect(readHermesProfileName('a-b_2')).toBe('a-b_2')
  })

  it('drops names that never name a --profile argument', () => {
    // `default` is the root home; `custom` is a Hermes-Desktop-chosen home.
    expect(readHermesProfileName('default')).toBeUndefined()
    expect(readHermesProfileName('custom')).toBeUndefined()
    expect(readHermesProfileName('')).toBeUndefined()
    expect(readHermesProfileName(undefined)).toBeUndefined()
  })

  it('drops ids outside Hermes profile grammar and shell-unsafe text', () => {
    expect(readHermesProfileName('-p')).toBeUndefined()
    expect(readHermesProfileName('Work')).toBeUndefined()
    expect(readHermesProfileName('a;b')).toBeUndefined()
    expect(readHermesProfileName('x'.repeat(65))).toBeUndefined()
  })
})

describe('hermesStateDbProfileArgs', () => {
  it('reads the profile from a named store path', () => {
    expect(hermesStateDbProfileArgs('/h/.hermes/profiles/work/state.db#abc')).toEqual([
      '-p',
      'work'
    ])
    expect(hermesStateDbProfileArgs('C:\\h\\.hermes\\profiles\\work\\state.db#abc')).toEqual([
      '-p',
      'work'
    ])
  })

  it('reads the root store as the default profile', () => {
    expect(hermesStateDbProfileArgs('/h/.hermes/state.db#abc')).toEqual(['-p', 'default'])
  })

  it('classifies store paths without inventing profiles', () => {
    expect(hermesStateDbProfile('/h/.hermes/state.db#abc')).toBe('default')
    expect(hermesStateDbProfile('\\h\\.hermes\\profiles\\work\\state.db#abc')).toBe('work')
    expect(hermesStateDbProfile('/h/.claude/sessions/x.jsonl')).toBeNull()
    expect(hermesStateDbProfile('/h/.hermes/profiles/Work/state.db#abc')).toBeNull()
  })

  it('passes other agents stores through unnamed', () => {
    expect(hermesStateDbProfileArgs('/h/.claude/sessions/x.jsonl')).toEqual([])
    expect(hermesStateDbProfileArgs(null)).toEqual([])
  })
})

describe('hermesProfileRoot', () => {
  it('reduces a profile home to its root', () => {
    expect(hermesProfileRoot('/h/.hermes/profiles/work')).toBe('/h/.hermes')
    expect(hermesProfileRoot('C:\\h\\.hermes\\profiles\\work\\')).toBe('C:\\h\\.hermes')
  })

  it('keeps the root home', () => {
    expect(hermesProfileRoot('/h/.hermes')).toBe('/h/.hermes')
  })
})
