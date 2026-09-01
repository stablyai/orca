import { describe, expect, it } from 'vitest'
import {
  areLocalWindowsWslPathAliases,
  isCaseInsensitiveRuntimeRoot,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  isWslUncPathForCallerLinuxPath,
  isWslUncPathForLinuxMountedPath,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from './cross-platform-path'

describe('local Windows WSL aliases', () => {
  it('matches UNC aliases and mounted drives without folding Linux path case', () => {
    expect(
      areLocalWindowsWslPathAliases(
        '//wsl.localhost/Ubuntu/home/Alice/file.ts',
        '\\\\wsl$\\ubuntu\\home\\Alice\\file.ts'
      )
    ).toBe(true)
    expect(
      areLocalWindowsWslPathAliases(
        '//wsl.localhost/Ubuntu/home/Alice/file.ts',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\file.ts'
      )
    ).toBe(false)
    expect(
      areLocalWindowsWslPathAliases(
        '//wsl.localhost/Ubuntu/mnt/c/repo/file.ts',
        'C:\\repo\\file.ts'
      )
    ).toBe(true)
    expect(
      areLocalWindowsWslPathAliases('//server/share/file.ts', '\\\\server\\share\\file.ts')
    ).toBe(false)
  })
})

describe('isCaseInsensitiveRuntimeRoot', () => {
  it('folds Windows drive and plain UNC roots', () => {
    expect(isCaseInsensitiveRuntimeRoot('C:\\repos\\app')).toBe(true)
    expect(isCaseInsensitiveRuntimeRoot('c:/repos/app')).toBe(true)
    expect(isCaseInsensitiveRuntimeRoot('\\\\server\\share\\app')).toBe(true)
  })

  it('keeps WSL UNC and POSIX roots case-sensitive', () => {
    expect(isCaseInsensitiveRuntimeRoot('\\\\wsl.localhost\\Ubuntu\\home\\ada\\app')).toBe(false)
    expect(isCaseInsensitiveRuntimeRoot('//wsl$/Ubuntu/home/ada/app')).toBe(false)
    expect(isCaseInsensitiveRuntimeRoot('/home/ada/app')).toBe(false)
    expect(isCaseInsensitiveRuntimeRoot('/Users/ada/app')).toBe(false)
  })
})

describe('isWslUncPathForCallerLinuxPath', () => {
  const UBUNTU = 'Ubuntu-24.04'

  it('matches the Linux path a WSL shell prints against both UNC spellings of its own distro', () => {
    expect(
      isWslUncPathForCallerLinuxPath(
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\neil\\qa-repo',
        '/home/neil/qa-repo',
        UBUNTU
      )
    ).toBe(true)
    expect(
      isWslUncPathForCallerLinuxPath(
        '//wsl$/ubuntu-24.04/home/neil/qa-repo',
        '/home/neil/qa-repo',
        UBUNTU
      )
    ).toBe(true)
  })

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

  it('matches macOS NFD paths against agent-recorded NFC paths', () => {
    // Regression for #10832: macOS file pickers hand Orca decomposed (NFD) paths
    // while Claude Code records cwd and names its project dirs in NFC, so a
    // non-ASCII workspace never matched its own sessions.
    const nfc = '/Users/ada/내 드라이브/프로젝트'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)

    expect(normalizeRuntimePathForComparison(nfd)).toBe(normalizeRuntimePathForComparison(nfc))
    expect(isPathInsideOrEqual(nfd, `${nfc}/src`)).toBe(true)
    expect(isPathInsideOrEqual(nfc, `${nfd}/src`)).toBe(true)

    // WSL UNC keys return before the trailing fold, so they need NFC too.
    expect(
      normalizeRuntimePathForComparison(
        `\\\\wsl$\\Ubuntu\\home\\ada\\${'프로젝트'.normalize('NFD')}`
      )
    ).toBe(normalizeRuntimePathForComparison(`\\\\wsl.localhost\\Ubuntu\\home\\ada\\프로젝트`))
  })

  it('returns a byte-exact suffix when comparison folding changes length', () => {
    // Comparison folding (NFC, case) is not length-preserving, so slicing the raw
    // candidate by the folded root's length would cut mid-character and fabricate
    // a path — callers rejoin this suffix and hit the filesystem with it.
    const nfc = '/Users/ada/프로젝트'
    const nfd = nfc.normalize('NFD')
    for (const root of [nfc, nfd]) {
      for (const candidate of [nfc, nfd]) {
        expect(relativePathInsideRoot(root, `${candidate}/src/index.ts`)).toBe('src/index.ts')
      }
    }

    // Pre-existing over-slice: toLowerCase expands U+0130 to two UTF-16 units.
    expect(relativePathInsideRoot('C:\\İş', 'C:\\İş\\src\\a.ts')).toBe('src/a.ts')

    // U+212A KELVIN SIGN folds to 'K', so the root and candidate must agree on
    // Windows-ness or their segment counts desync and the suffix comes back ''.
    expect(relativePathInsideRoot('\u212A:/a\\b', '\u212A:/a\\b/c')).toBe(
      relativePathInsideRoot('K:/a\\b', 'K:/a\\b/c')
    )

    // Astral characters must not be cut mid-surrogate-pair.
    expect(relativePathInsideRoot('/repo/🚀app', '/repo/🚀app/src/🎉file.ts')).toBe('src/🎉file.ts')

    // A UNC-shaped candidate under POSIX root '/' used to yield a leading slash,
    // which is not a relative path.
    expect(relativePathInsideRoot('/', '//server/share/x')).toBe('server/share/x')

    // WSL suffixes must stay decomposed: they name files on a Linux filesystem,
    // where NFD and NFC are distinct entries.
    const decomposed = '프로젝트'.normalize('NFD')
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\ada\\repo',
        `\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo\\${decomposed}\\a.ts`
      )
    ).toBe(`${decomposed}/a.ts`)
  })

  it('resolves POSIX relative paths without using the process cwd', () => {
    expect(resolveRuntimePath('/repos/app/repo', '../worktrees/feature')).toBe(
      '/repos/app/worktrees/feature'
    )
    expect(resolveRuntimePath('/repos/app/repo', '/custom/worktrees')).toBe('/custom/worktrees')
    expect(isRuntimePathAbsolute('../worktrees')).toBe(false)
  })

  it('resolves Windows relative paths with Windows semantics', () => {
    expect(resolveRuntimePath('C:\\Repos\\app\\repo', '..\\worktrees\\feature')).toBe(
      'C:/Repos/app/worktrees/feature'
    )
    expect(resolveRuntimePath('C:\\Repos\\app\\repo', 'D:\\worktrees')).toBe('D:/worktrees')
    expect(isRuntimePathAbsolute('/remote/worktrees', 'windows')).toBe(true)
  })
})
