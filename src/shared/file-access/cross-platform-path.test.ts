import { describe, expect, it } from 'vitest'
import {
  isPathInsideOrEqual,
  isWslUncPathForCallerLinuxPath,
  isWslUncPathForLinuxMountedPath,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from './cross-platform-path'

describe('isWslUncPathForCallerLinuxPath', () => {
  const UBUNTU = 'Ubuntu-24.04'

  // The destructive case: this feeds `worktree rm`, so a tail-only match deletes the wrong distro.
  it('refuses a Linux path another distro spells identically', () => {
    expect(
      isWslUncPathForCallerLinuxPath(
        '\\\\wsl.localhost\\Debian\\home\\neil\\qa-repo',
        '/home/neil/qa-repo',
        UBUNTU
      )
    ).toBe(false)
  })

  it('keeps the Linux tail case-sensitive and refuses a non-WSL path', () => {
    expect(
      isWslUncPathForCallerLinuxPath(
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\Neil\\qa-repo',
        '/home/neil/qa-repo',
        UBUNTU
      )
    ).toBe(false)
    expect(isWslUncPathForCallerLinuxPath('/home/neil/qa-repo', '/home/neil/qa-repo', UBUNTU)).toBe(
      false
    )
    expect(isWslUncPathForCallerLinuxPath('C:\\repos\\qa-repo', '/home/neil/qa-repo', UBUNTU)).toBe(
      false
    )
  })
})

describe('isWslUncPathForLinuxMountedPath', () => {
  it('matches a shared /mnt drive regardless of distro', () => {
    expect(
      isWslUncPathForLinuxMountedPath(
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\Neil\\repo',
        '/mnt/c/users/neil/repo'
      )
    ).toBe(true)
    expect(
      isWslUncPathForLinuxMountedPath(
        '\\\\wsl.localhost\\Debian\\mnt\\c\\Users\\Neil\\repo',
        '/mnt/c/users/neil/repo'
      )
    ).toBe(true)
  })

  it('keeps non-mounted Linux paths out of the distro-independent match', () => {
    expect(
      isWslUncPathForLinuxMountedPath(
        '\\\\wsl.localhost\\Ubuntu\\home\\Neil\\repo',
        '/home/neil/repo'
      )
    ).toBe(false)
  })
})

describe('cross-platform path containment', () => {
  it('keeps POSIX sibling prefixes outside the root', () => {
    expect(isPathInsideOrEqual('/repo/app', '/repo/app')).toBe(true)
    expect(isPathInsideOrEqual('/repo/app', '/repo/app/src/index.ts')).toBe(true)
    expect(isPathInsideOrEqual('/repo/app', '/repo/application/src/index.ts')).toBe(false)
    expect(relativePathInsideRoot('/repo/app/', '/repo/app/src/index.ts')).toBe('src/index.ts')
  })

  it('keeps literal POSIX backslashes distinct from separators', () => {
    expect(normalizeRuntimePathForComparison('/srv/team\\repo')).toBe('/srv/team\\repo')
    expect(normalizeRuntimePathForComparison('/srv/team/repo')).toBe('/srv/team/repo')
    expect(isPathInsideOrEqual('/srv/team\\repo', '/srv/team/repo/file.ts')).toBe(false)
    expect(relativePathInsideRoot('/srv/repo', '/srv/repo/a\\b.txt')).toBe('a\\b.txt')
  })

  it('handles Windows drive roots and sibling drives case-insensitively', () => {
    expect(isPathInsideOrEqual('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe(true)
    expect(relativePathInsideRoot('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe('src/index.ts')
    expect(isPathInsideOrEqual('C:\\Repo', 'D:\\Repo\\src\\index.ts')).toBe(false)
    expect(relativePathInsideRoot('C:\\', 'c:\\repo\\src\\index.ts')).toBe('repo/src/index.ts')
  })

  it('handles UNC roots, trailing slashes, mixed separators, and case', () => {
    expect(isPathInsideOrEqual('\\\\Server\\Share\\Repo\\', '//server/share/repo/src')).toBe(true)
    expect(relativePathInsideRoot('\\\\Server\\Share\\Repo\\', '//server/share/repo/src')).toBe(
      'src'
    )
    expect(isPathInsideOrEqual('\\\\Server\\Share\\Repo', '\\\\server\\share\\repo2')).toBe(false)
  })

  it('treats WSL UNC aliases as the same case-sensitive filesystem', () => {
    expect(
      isPathInsideOrEqual(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\src'
      )
    ).toBe(true)
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\Src'
      )
    ).toBe('Src')
    expect(
      isPathInsideOrEqual(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src'
      )
    ).toBe(false)
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src'
      )
    ).toBeNull()
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\line\nbreak'
      )
    ).toBe('line\nbreak')
  })
})
