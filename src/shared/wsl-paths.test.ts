import { describe, expect, it } from 'vitest'
import {
  foldWslUncPathCaseInsensitiveParts,
  getWslFilesystemBoundaryDistro,
  isDrvfsLinuxPath,
  isWslUncPath,
  parseWslUncPath,
  resolveWslRepoWorktreeBasePath,
  toWindowsWslDrivePath,
  toWindowsWslPath,
  toWindowsWslUncPath
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

  it.each([
    ['/mnt/c/Users/jin', 'C:\\Users\\jin'],
    ['/mnt/d', 'D:\\'],
    ['/mnt/d/', 'D:\\'],
    ['/MNT/c/Users/jin', null],
    ['/mnt/C/Repo', null],
    ['/home/jin', null],
    // A drvfs prefix on a line that still carries a terminator is not a drive path.
    ['/mnt/c/Users/jin\r', null],
    ['/mnt/c/Users/jin\n', null],
    ['/mnt/c/Users/jin\u2028', null],
    ['/mnt/c/Users/jin\u2029', null]
  ] as const)('converts the DrvFs path %j without a distro lookup', (linuxPath, expected) => {
    expect(toWindowsWslDrivePath(linuxPath)).toBe(expected)
  })

  it.each(['\r', '\n', '\u2028', '\u2029'])(
    'leaves a DrvFs line ending in %j on the distro UNC view',
    (terminator) => {
      expect(toWindowsWslPath(`/mnt/c/Users/jin${terminator}`, 'Ubuntu')).toBe(
        `\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\jin${terminator}`
      )
    }
  )

  it('keeps mounted-drive paths on the distro UNC view when requested', () => {
    expect(toWindowsWslUncPath('/mnt/c/Users/jin', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\jin'
    )
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

describe('getWslFilesystemBoundaryDistro', () => {
  it('names the runtime distro for a Windows drive project running WSL git', () => {
    expect(
      getWslFilesystemBoundaryDistro({
        projectPath: 'C:\\Users\\alice\\orca',
        wslRuntimeDistro: 'Ubuntu-24.04'
      })
    ).toBe('Ubuntu-24.04')
  })

  it('stays silent for a Windows drive project running host git', () => {
    for (const wslRuntimeDistro of [undefined, null, '']) {
      expect(
        getWslFilesystemBoundaryDistro({ projectPath: 'C:/Users/alice/orca', wslRuntimeDistro })
      ).toBeNull()
    }
  })

  it('stays silent for a project already inside the distro', () => {
    expect(
      getWslFilesystemBoundaryDistro({
        projectPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\orca',
        wslRuntimeDistro: 'Ubuntu'
      })
    ).toBeNull()
  })

  // The UNC spelling of drvfs is still the Windows drive, so it crosses the boundary even though
  // the path names no runtime preference at all.
  it('names the path distro for the UNC spelling of a drvfs mount', () => {
    expect(
      getWslFilesystemBoundaryDistro({
        projectPath: '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\alice\\orca'
      })
    ).toBe('Ubuntu')
  })

  it('stays silent for POSIX, relative, and plain UNC share paths', () => {
    for (const projectPath of ['/home/alice/orca', 'orca', '\\\\fileserver\\share\\orca']) {
      expect(getWslFilesystemBoundaryDistro({ projectPath, wslRuntimeDistro: 'Ubuntu' })).toBeNull()
    }
  })
})

describe('isDrvfsLinuxPath', () => {
  it('accepts the automount root and its descendants only', () => {
    expect(isDrvfsLinuxPath('/mnt/c')).toBe(true)
    expect(isDrvfsLinuxPath('/mnt/c/Users')).toBe(true)
    expect(isDrvfsLinuxPath('/mnt/cdrom')).toBe(false)
    // Why: /MNT and /mnt/C are ordinary case-sensitive Linux directories, not the drvfs automount.
    expect(isDrvfsLinuxPath('/MNT/c')).toBe(false)
    expect(isDrvfsLinuxPath('/mnt/C/Users')).toBe(false)
  })
})
