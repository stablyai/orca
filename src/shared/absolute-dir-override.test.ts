import { describe, expect, it } from 'vitest'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

const FALLBACK = '/home/user/.agent'

describe('resolveAbsoluteDirOverride', () => {
  it('keeps an absolute override', () => {
    expect(resolveAbsoluteDirOverride('/srv/sessions', FALLBACK)).toBe('/srv/sessions')
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(resolveAbsoluteDirOverride('  /srv/sessions  ', FALLBACK)).toBe('/srv/sessions')
  })

  it.each([
    ['a bare dot', '.'],
    ['a parent reference', '..'],
    ['a relative path', 'rel/path'],
    // Why: `C:foo` and `C:` are drive-*relative* on Windows — they resolve against that drive's
    // current directory, which is why `C:\` stripped of its separator is not a safe root (#13082).
    ['a drive-relative path', 'C:foo'],
    ['a bare drive letter', 'C:']
  ])('falls back for %s', (_label, value) => {
    expect(resolveAbsoluteDirOverride(value, FALLBACK)).toBe(FALLBACK)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   ']
  ])('falls back for %s', (_label, value) => {
    expect(resolveAbsoluteDirOverride(value, FALLBACK)).toBe(FALLBACK)
  })
})
