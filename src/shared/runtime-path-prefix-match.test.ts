import { describe, expect, it } from 'vitest'
import { matchesRuntimePathPrefix, prepareRuntimePathPrefixKey } from './runtime-path-prefix-match'

function matches(candidatePath: string, typedPrefix: string): boolean {
  return matchesRuntimePathPrefix(prepareRuntimePathPrefixKey(candidatePath), typedPrefix)
}

describe('runtime path prefix match', () => {
  it('accepts equivalent spellings of a POSIX candidate', () => {
    expect(matches('/repo/alpha', '/repo//alpha')).toBe(true)
    expect(matches('/repo//alpha', '/repo/alpha')).toBe(true)
    expect(matches('/repo/café'.normalize('NFC'), '/repo/café'.normalize('NFD'))).toBe(true)
    expect(matches('/repo/café'.normalize('NFD'), '/repo/café'.normalize('NFC'))).toBe(true)
  })

  it('keeps POSIX names case-sensitive and backslashes literal', () => {
    expect(matches('/repo/Alpha', '/repo/alpha')).toBe(false)
    expect(matches('/repo/foo\\bar', '/repo/foo\\')).toBe(true)
    expect(matches('/repo/foo\\bar', '/repo/foo/')).toBe(false)
  })

  it('folds a whole drive or plain UNC candidate, including half-typed prefixes', () => {
    for (const prefix of ['C', 'C:', 'C:\\', 'c:/users', 'C:\\USERS\\ALICE\\']) {
      expect(matches('C:\\Users\\Alice\\repo', prefix)).toBe(true)
    }
    expect(matches('C:\\Users\\Alice\\repo', 'D:')).toBe(false)
    for (const prefix of ['\\', '\\\\', '\\\\SERVER', '//server/share']) {
      expect(matches('\\\\server\\share\\x', prefix)).toBe(true)
    }
  })

  it('folds a WSL share alias and distro but nothing below it', () => {
    const wsl = '//wsl.localhost/Ubuntu/home/Ada/Repo'
    for (const prefix of ['//w', '//WSL.LOCALHOST', '//wsl$', '//wsl$/Ubuntu/home/Ada']) {
      expect(matches(wsl, prefix)).toBe(true)
    }
    expect(matches(wsl, '//wsl.localhost/Ubuntu/home/ada')).toBe(false)
    expect(matches(wsl, '//wsl.localhostx')).toBe(false)
  })

  // Why: U+0130 lowercases to two code units, so a boundary measured on one side
  // and reused on the other lands mid-segment. Both directions must be covered.
  it('finds the WSL fold boundary in each value, not a shared offset', () => {
    expect(matches('//wsl.localhost/\u0130x/home', '//wsl.localhost/i\u0307X')).toBe(true)
    expect(matches('//wsl.localhost/i\u0307i\u0307/a', '//wsl.localhost/\u0130\u0130/A')).toBe(
      false
    )
    expect(matches('//wsl.localhost/i\u0307i\u0307/a', '//wsl.localhost/\u0130\u0130/a')).toBe(true)
  })

  it('pins a trailing separator to a whole segment', () => {
    expect(matches('/repo/alpha', '/repo/')).toBe(true)
    expect(matches('/repo/alpha', '/repo/alpha/')).toBe(true)
    expect(matches('/repository/x', '/repo/')).toBe(false)
    expect(matches('C:\\Users\\Alice', 'C:\\Users\\')).toBe(true)
    expect(matches('C:\\UsersExtra\\x', 'C:\\Users\\')).toBe(false)
  })

  // Why: a root has no parent segment to pin to, and `//` is UNC syntax rather
  // than a separator, so it must not collapse onto the POSIX root.
  it('never pins a root prefix onto a different root', () => {
    expect(matches('/', '//')).toBe(false)
    expect(matches('', '/')).toBe(false)
    expect(matches('/', '/')).toBe(true)
    expect(matches('/repo/alpha', '/')).toBe(true)
    expect(matches('C:\\x', 'C:/')).toBe(true)
  })

  // Why: NFC composition destroys the boundary of a prefix that stops at the base
  // character, so a decomposed candidate must stay reachable even when the prefix
  // also needs separator or case preparation.
  it('keeps a prefix that stops before a combining mark reachable', () => {
    expect(matches('/repo/e\u0301x', '/repo/e')).toBe(true)
    expect(matches('/repo/e\u0301x', '/repo//e')).toBe(true)
    expect(matches('C:\\repo\\E\u0301x', 'c:/repo/e')).toBe(true)
    expect(matches('/repo/\u00e9x', '/repo/e')).toBe(true)
    expect(matches('/repo/e\u0301x', '/repo/f')).toBe(false)
  })

  // Why: NFD reorders combining marks by canonical class, so a prefix that stops
  // between two marks loses its boundary in the decomposed spelling. The
  // order-preserving spelling is what keeps these reachable.
  it('keeps a prefix that stops between combining marks reachable', () => {
    expect(matches('/repo/a\u0315\u0300x', '/repo//a\u0315')).toBe(true)
    expect(matches('/repo/a\u0315\u0300x', '/repo/a\u0315')).toBe(true)
    expect(matches('C:\\repo\\A\u0315\u0300x', 'c:/repo/a\u0315')).toBe(true)
    expect(matches('//wsl.localhost/A\u0315\u0300/home', '//wsl$/a\u0315')).toBe(true)
    expect(matches('/repo/a\u0315\u0300x', '/repo//a\u0316')).toBe(false)
  })

  // Why: a prefix being typed always sits at a word end, where `toLowerCase`
  // maps a capital sigma to final sigma and breaks the prefix relation.
  it('folds case without the final-sigma context rule', () => {
    expect(matches('C:\\\u0391\u03a3\u03a7', 'C:\\\u0391\u03a3')).toBe(true)
    expect(matches('C:\\\u0391\u03a3\u03a7', 'c:/\u03b1\u03c3')).toBe(true)
    expect(matches('C:\\\u0391\u03a3\u03a7', 'c:/\u03b1\u03c2')).toBe(true)
  })

  it('refuses a prefix longer than the candidate', () => {
    expect(matches('/repo', '/repo/alpha')).toBe(false)
  })
})
