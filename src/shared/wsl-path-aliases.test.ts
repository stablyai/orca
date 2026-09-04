import { describe, expect, it } from 'vitest'
import {
  isWslAliasedPathInsideOrEqual,
  normalizedWslPathCandidateAliases,
  wslAliasedPathDepth,
  wslRootPathAliases
} from './wsl-path-aliases'

describe('wslRootPathAliases', () => {
  it('pairs a Windows drive path with its WSL drvfs mount', () => {
    expect(wslRootPathAliases(String.raw`C:\Users\neil\orca\orca`)).toEqual([
      String.raw`C:\Users\neil\orca\orca`,
      '/mnt/c/Users/neil/orca/orca'
    ])
  })

  it('does not reinterpret a raw POSIX mount as WSL drvfs', () => {
    expect(wslRootPathAliases('/mnt/c/Users/neil/orca/orca')).toEqual([
      '/mnt/c/Users/neil/orca/orca'
    ])
  })

  it('keeps distro-native UNC aliases and unfolds a UNC-mounted drive', () => {
    expect(wslRootPathAliases(String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`)).toEqual([
      String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
      '/home/ada/repo'
    ])
    expect(wslRootPathAliases(String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\neil\orca`)).toEqual([
      String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\neil\orca`,
      '/mnt/c/Users/neil/orca',
      String.raw`C:\Users\neil\orca`
    ])
    expect(wslRootPathAliases(String.raw`\\wsl.localhost\Ubuntu\mnt\C\Repo`)).toEqual([
      String.raw`\\wsl.localhost\Ubuntu\mnt\C\Repo`,
      '/mnt/C/Repo'
    ])
  })

  it('does not invent aliases for an ordinary POSIX path', () => {
    expect(wslRootPathAliases('/home/ada/repo')).toEqual(['/home/ada/repo'])
  })
})

describe('isWslAliasedPathInsideOrEqual', () => {
  it('treats C:\\ and /mnt/c as the same workspace, including case-folded drives', () => {
    expect(
      isWslAliasedPathInsideOrEqual(
        String.raw`C:\Users\neil\orca\orca`,
        '/mnt/c/Users/neil/orca/orca'
      )
    ).toBe(true)
    expect(
      isWslAliasedPathInsideOrEqual(
        String.raw`c:\users\neil\orca\orca`,
        '/mnt/c/Users/neil/orca/orca/src'
      )
    ).toBe(true)
  })

  it('rejects a sibling path that only shares a prefix', () => {
    expect(
      isWslAliasedPathInsideOrEqual(String.raw`C:\Users\neil\orca`, '/mnt/c/Users/neil/orca-secret')
    ).toBe(false)
  })

  it('still matches a WSL UNC worktree against a Linux cwd', () => {
    expect(
      isWslAliasedPathInsideOrEqual(
        String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
        '/home/ada/repo/app'
      )
    ).toBe(true)
  })

  it('preserves case for a raw POSIX /mnt root', () => {
    expect(
      isWslAliasedPathInsideOrEqual('/mnt/c/Users/Neil/repo', '/mnt/c/Users/Neil/repo/src')
    ).toBe(true)
    expect(
      isWslAliasedPathInsideOrEqual('/mnt/c/Users/Neil/repo', '/mnt/c/users/neil/repo/src')
    ).toBe(false)
  })

  it('does not reinterpret a case-variant /mnt/C directory as a drive mount', () => {
    expect(isWslAliasedPathInsideOrEqual(String.raw`C:\Repo`, '/mnt/C/Repo/src')).toBe(false)
  })

  it('preserves the distro identity of UNC candidates', () => {
    const ubuntuRoot = String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`
    expect(isWslAliasedPathInsideOrEqual(ubuntuRoot, '/home/ada/repo/src')).toBe(true)
    expect(
      isWslAliasedPathInsideOrEqual(
        ubuntuRoot,
        String.raw`\\wsl.localhost\Debian\home\ada\repo\src`
      )
    ).toBe(false)
  })
})

describe('normalizedWslPathCandidateAliases', () => {
  it('folds the Windows drive spelling so /mnt/c can match a case-variant workspace', () => {
    expect(normalizedWslPathCandidateAliases('/mnt/c/Users/neil/orca/orca')).toEqual([
      '/mnt/c/Users/neil/orca/orca',
      'c:/users/neil/orca/orca'
    ])
  })

  it('keeps a case-variant /mnt/C candidate as a case-sensitive Linux path', () => {
    expect(normalizedWslPathCandidateAliases('/mnt/C/Repo')).toEqual(['/mnt/C/Repo'])
  })
})

describe('wslAliasedPathDepth', () => {
  it('assigns one depth to every spelling of a drvfs path', () => {
    expect([
      wslAliasedPathDepth(String.raw`C:\Users\neil\orca`),
      wslAliasedPathDepth('/mnt/c/Users/neil/orca'),
      wslAliasedPathDepth(String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\neil\orca`)
    ]).toEqual([5, 5, 5])
  })

  it('assigns one depth to distro-native UNC and Linux spellings', () => {
    expect(wslAliasedPathDepth(String.raw`\\wsl$\Ubuntu\home\ada\repo`)).toBe(3)
    expect(wslAliasedPathDepth('/home/ada/repo')).toBe(3)
  })

  it('preserves POSIX and drvfs nesting', () => {
    expect(wslAliasedPathDepth('/srv/repo/child')).toBeGreaterThan(wslAliasedPathDepth('/srv/repo'))
    expect(wslAliasedPathDepth('C:\\')).toBeGreaterThan(wslAliasedPathDepth('/mnt'))
  })
})
