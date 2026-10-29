import { describe, expect, it } from 'vitest'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

const FALLBACK = '/home/user/.agent'

describe('resolveAbsoluteDirOverride', () => {
  it('keeps an absolute override, trimming first', () => {
    expect(resolveAbsoluteDirOverride('/srv/sessions', FALLBACK, 'linux')).toBe('/srv/sessions')
    expect(resolveAbsoluteDirOverride('  /srv/sessions  ', FALLBACK, 'linux')).toBe('/srv/sessions')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   ']
  ])('falls back for %s', (_label, value) => {
    expect(resolveAbsoluteDirOverride(value, FALLBACK, 'linux')).toBe(FALLBACK)
    expect(resolveAbsoluteDirOverride(value, FALLBACK, 'win32')).toBe(FALLBACK)
  })

  it.each([
    ['a bare dot', '.'],
    ['a parent reference', '..'],
    ['a relative path', 'rel/path'],
    // Grok1.0.30 treats ~/ literally under its cwd; expanding it would read a directory the agent never wrote.
    ['an unexpanded tilde', '~/sessions'],
    // Drive-*relative*: both resolve against that drive's current directory, not its root.
    ['a drive-relative path', 'C:foo'],
    ['a bare drive letter', 'C:']
  ])('falls back for %s on every platform', (_label, value) => {
    expect(resolveAbsoluteDirOverride(value, FALLBACK, 'linux')).toBe(FALLBACK)
    expect(resolveAbsoluteDirOverride(value, FALLBACK, 'darwin')).toBe(FALLBACK)
    expect(resolveAbsoluteDirOverride(value, FALLBACK, 'win32')).toBe(FALLBACK)
  })

  // Exercise Windows path shapes even on POSIX CI; native POSIX predicates would reject valid Windows roots.
  it.each([
    ['a drive-rooted path', 'C:\\Users\\ada\\.grok'],
    ['a forward-slash drive root', 'C:/Users/ada/.grok'],
    ['a UNC share', '\\\\server\\share\\grok'],
    // Rooted but drive-relative; `path.resolve` still bounds it to the current drive.
    ['a drive-current-root path', '\\grok']
  ])('keeps %s on Windows', (_label, value) => {
    expect(resolveAbsoluteDirOverride(value, FALLBACK, 'win32')).toBe(value)
  })

  it.each([['C:\\Users\\ada\\.grok'], ['\\\\server\\share\\grok'], ['\\grok']])(
    'falls back for the Windows path %j on POSIX',
    (value) => {
      expect(resolveAbsoluteDirOverride(value, FALLBACK, 'linux')).toBe(FALLBACK)
    }
  )

  it('defaults to the host platform', () => {
    const rooted = process.platform === 'win32' ? 'C:\\srv\\sessions' : '/srv/sessions'
    expect(resolveAbsoluteDirOverride(rooted, FALLBACK)).toBe(rooted)
    expect(resolveAbsoluteDirOverride('rel/path', FALLBACK)).toBe(FALLBACK)
  })
})
