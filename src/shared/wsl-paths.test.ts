import { describe, expect, it } from 'vitest'
import {
  foldWslUncPathCaseInsensitiveParts,
  isWslUncPath,
  parseWslUncPath,
  resolveWslRepoWorktreeBasePath,
  toWindowsWslPath
} from './wsl-paths'

describe('wsl path helpers', () => {
  it('parses modern and legacy WSL UNC paths without platform checks', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/repo'
    })
    expect(parseWslUncPath('\\\\wsl$\\Debian\\home\\jin')).toEqual({
      distro: 'Debian',
      linuxPath: '/home/jin'
    })
  })

  it('rejects ordinary Windows and POSIX paths', () => {
    expect(isWslUncPath('C:\\Users\\jin\\repo')).toBe(false)
    expect(isWslUncPath('/home/jin/repo')).toBe(false)
  })

  it.each([
    ['/home/jin/repo', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'],
    ['/', '\\\\wsl.localhost\\Ubuntu\\'],
    ['/mnt/c/Users/jin', 'C:\\Users\\jin'],
    ['/MNT/c/Repo', '\\\\wsl.localhost\\Ubuntu\\MNT\\c\\Repo'],
    ['/mnt/C/Repo', '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\Repo']
  ])('converts %s without folding case-sensitive Linux paths', (linuxPath, expected) => {
    expect(toWindowsWslPath(linuxPath, 'Ubuntu')).toBe(expected)
  })
})

describe('resolveWslRepoWorktreeBasePath', () => {
  const WSL_REPO = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\src\\repo'

  it('resolves an absolute Linux base path into the repo distro (STA-4772)', () => {
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '/home/jin/project/.orca-worktrees')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\project\\.orca-worktrees'
    )
    expect(resolveWslRepoWorktreeBasePath('\\\\wsl$\\Debian\\srv\\repo', '/srv/trees')).toBe(
      '\\\\wsl.localhost\\Debian\\srv\\trees'
    )
  })

  it('keeps drvfs base paths on the distro UNC view so mirroring cannot discard them', () => {
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '/mnt/d/trees')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\d\\trees'
    )
  })

  it('collapses dot segments and trailing slashes so ownership layouts match creation', () => {
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '/home/jin/src/../trees')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\trees'
    )
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '/home/jin/./trees/')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\trees'
    )
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '/../..')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\'
    )
  })

  it('keeps UNC, drive, and relative base paths untouched for WSL repos', () => {
    expect(
      resolveWslRepoWorktreeBasePath(WSL_REPO, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\trees')
    ).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\trees')
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '//wsl.localhost/Ubuntu-24.04/trees')).toBe(
      '//wsl.localhost/Ubuntu-24.04/trees'
    )
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, 'D:\\trees')).toBe('D:\\trees')
    expect(resolveWslRepoWorktreeBasePath(WSL_REPO, '../worktrees')).toBe('../worktrees')
  })

  it('never rewrites base paths of non-WSL repos', () => {
    expect(resolveWslRepoWorktreeBasePath('C:\\src\\repo', '/home/jin/trees')).toBe(
      '/home/jin/trees'
    )
    expect(resolveWslRepoWorktreeBasePath('/srv/repo', '/srv/trees')).toBe('/srv/trees')
    expect(resolveWslRepoWorktreeBasePath('//server/share/repo', '/srv/trees')).toBe('/srv/trees')
  })
})

describe('foldWslUncPathCaseInsensitiveParts', () => {
  it('folds share spelling, distro casing, and separators but not the Linux tail', () => {
    expect(foldWslUncPathCaseInsensitiveParts('\\\\WSL$\\Ubuntu\\home\\jin\\Repo')).toBe(
      '//wsl.localhost/ubuntu/home/jin/Repo'
    )
    expect(foldWslUncPathCaseInsensitiveParts('//wsl.localhost/UBUNTU/home/jin/Repo')).toBe(
      '//wsl.localhost/ubuntu/home/jin/Repo'
    )
  })

  it('folds drvfs automount tails but not other /mnt entries', () => {
    expect(foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\mnt\\C\\Users\\Jin')).toBe(
      '//wsl.localhost/ubuntu/mnt/c/users/jin'
    )
    expect(foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\mnt\\wsl\\Data')).toBe(
      '//wsl.localhost/ubuntu/mnt/wsl/Data'
    )
  })

  it('does not treat a case-variant /MNT dir as the drvfs automount', () => {
    expect(foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\MNT\\c\\Repo')).toBe(
      '//wsl.localhost/ubuntu/MNT/c/Repo'
    )
  })

  it('returns null for non-WSL paths', () => {
    expect(foldWslUncPathCaseInsensitiveParts('C:\\Users\\jin')).toBeNull()
    expect(foldWslUncPathCaseInsensitiveParts('//server/share/x')).toBeNull()
    expect(foldWslUncPathCaseInsensitiveParts('/home/jin')).toBeNull()
  })
})
