import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGitMetadataPath, resolveWorktreeHostPath } from './git-metadata-path'

const hostIsWindows = process.platform === 'win32'

describe('resolveGitMetadataPath', () => {
  it('maps a drvfs pointer to its drive spelling on a Windows host with no distro context', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`C:\Users\me\repo`,
        '/mnt/c/Users/me/repo/.git/worktrees/feature',
        { platform: 'win32' }
      )
    ).toBe(String.raw`C:\Users\me\repo\.git\worktrees\feature`)
  })

  it('maps a drvfs drive root to its drive spelling', () => {
    expect(resolveGitMetadataPath(String.raw`D:\repo`, '/mnt/d', { platform: 'win32' })).toBe(
      'D:\\'
    )
  })

  it('keeps a non-drvfs guest pointer verbatim when no distro names it', () => {
    // Windows already reads this as drive-relative; guessing a distro would probe the wrong disk.
    expect(
      resolveGitMetadataPath(String.raw`C:\repo`, '/home/me/repo/.git', { platform: 'win32' })
    ).toBe('/home/me/repo/.git')
  })

  it('maps a guest pointer through the distro encoded by a WSL UNC base', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Debian\home\me\repo`,
        '/home/me/repo/.git',
        { platform: 'win32' }
      )
    ).toBe(String.raw`\\wsl.localhost\Debian\home\me\repo\.git`)
  })

  it('maps a guest pointer through a caller-named distro when the base encodes none', () => {
    expect(
      resolveGitMetadataPath(String.raw`C:\Users\me\repo`, '/home/me/repo/.git', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).toBe(String.raw`\\wsl.localhost\Ubuntu\home\me\repo\.git`)
  })

  // Git for Windows spells a UNC gitdir with forward slashes; that is already a host path, and
  // translating it would produce `\\wsl.localhost\Ubuntu\\wsl.localhost\Ubuntu\...`.
  it('keeps a forward-slash UNC pointer verbatim rather than re-prefixing the share', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Ubuntu\home\me\repo\feature`,
        '//wsl.localhost/Ubuntu/home/me/repo/.git/worktrees/feature',
        { platform: 'win32', wslDistro: 'Ubuntu' }
      )
    ).toBe('//wsl.localhost/Ubuntu/home/me/repo/.git/worktrees/feature')
  })

  it('lets the distro encoded by a WSL UNC base outrank the caller-named one', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Debian\home\me\repo`,
        '/home/me/repo/.git',
        { platform: 'win32', wslDistro: 'Ubuntu' }
      )
    ).toBe(String.raw`\\wsl.localhost\Debian\home\me\repo\.git`)
  })

  it('ignores a caller-named distro on a POSIX host', () => {
    // A POSIX reader is already in the pointer's namespace; a UNC path there would be a filename.
    expect(
      resolveGitMetadataPath('/repo', '/home/me/repo/.git', {
        platform: 'linux',
        wslDistro: 'Ubuntu'
      })
    ).toBe('/home/me/repo/.git')
    expect(
      resolveGitMetadataPath('/repo', '/mnt/c/repo/.git', {
        platform: 'darwin',
        wslDistro: 'Ubuntu'
      })
    ).toBe('/mnt/c/repo/.git')
  })

  it('keeps a drvfs pointer on its drive spelling even when a distro is named', () => {
    expect(
      resolveGitMetadataPath(String.raw`C:\repo`, '/mnt/c/repo/.git', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).toBe(String.raw`C:\repo\.git`)
  })

  it('resolves a relative pointer against a WSL UNC base', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Debian\home\me\repo\.git\worktrees\feature`,
        '../..',
        { platform: 'win32' }
      )
    ).toBe(String.raw`\\wsl.localhost\Debian\home\me\repo\.git`)
  })

  it('resolves relative pointers with the reading host path flavor', () => {
    expect(
      resolveGitMetadataPath('/repo/worktree', '../.git/worktrees/feature', { platform: 'linux' })
    ).toBe('/repo/.git/worktrees/feature')
    expect(
      resolveGitMetadataPath(String.raw`C:\repo\worktree`, String.raw`..\.git\worktrees\feature`, {
        platform: 'win32'
      })
    ).toBe(String.raw`C:\repo\.git\worktrees\feature`)
  })

  it('leaves absolute pointers alone on a POSIX host, drvfs spelling included', () => {
    expect(
      resolveGitMetadataPath('/repo/worktree', '/var/lib/git/worktrees/feature', {
        platform: 'linux'
      })
    ).toBe('/var/lib/git/worktrees/feature')
    expect(
      resolveGitMetadataPath('/repo/worktree', '/mnt/c/repo/.git', { platform: 'darwin' })
    ).toBe('/mnt/c/repo/.git')
  })

  it.each(['', '   ', '\t'])('rejects an empty metadata pointer %j', (rawPath) => {
    expect(resolveGitMetadataPath('/repo', rawPath, { platform: 'linux' })).toBeNull()
  })

  it('trims a padded pointer before resolving it', () => {
    expect(resolveGitMetadataPath('/repo/worktree', '  ../.git  ', { platform: 'linux' })).toBe(
      '/repo/.git'
    )
  })

  // Both production callers omit options entirely, so the defaults must stay the old behavior:
  // the reading host's own path flavor, and no distro.
  it.each([
    [
      String.raw`\\wsl.localhost\Debian\home\me\repo`,
      '/home/me/repo/.git',
      String.raw`\\wsl.localhost\Debian\home\me\repo\.git`
    ],
    ['/repo', '/mnt/c/repo/.git', hostIsWindows ? String.raw`C:\repo\.git` : '/mnt/c/repo/.git'],
    ['/repo', '/var/lib/git/worktrees/feature', '/var/lib/git/worktrees/feature'],
    ['/repo', '   ', null]
  ])('defaults to the current host with no distro for %j -> %j', (basePath, rawPath, expected) => {
    expect(resolveGitMetadataPath(basePath, rawPath)).toBe(expected)
  })

  it('resolves a relative pointer with no options in the reading host flavor', () => {
    // Expectation comes from node's own path module, not from a second call under test.
    expect(resolveGitMetadataPath('/repo/worktree', '../.git/worktrees/feature')).toBe(
      (hostIsWindows ? win32 : posix).resolve('/repo/worktree', '../.git/worktrees/feature')
    )
  })
})

describe('resolveWorktreeHostPath', () => {
  // A gitfile payload ends in a newline; a directory name can end in a space, and trimming one
  // away points every read at a directory that does not exist.
  it.each(['/repo/my feature ', ' /repo/my feature'])(
    'keeps whitespace that belongs to the directory name (%j)',
    (worktreePath) => {
      expect(resolveWorktreeHostPath(worktreePath, { platform: 'linux' })).toBe(worktreePath)
      expect(resolveWorktreeHostPath(worktreePath, { platform: 'win32' })).toBe(worktreePath)
    }
  )

  it('still translates a guest directory for a Windows reader', () => {
    expect(
      resolveWorktreeHostPath('/home/me/repo', { platform: 'win32', wslDistro: 'Ubuntu' })
    ).toBe(String.raw`\\wsl.localhost\Ubuntu\home\me\repo`)
    expect(resolveWorktreeHostPath('/mnt/c/repo', { platform: 'win32' })).toBe(String.raw`C:\repo`)
  })

  it.each(['', '   '])('has no spelling for an empty worktree path %j', (worktreePath) => {
    expect(resolveWorktreeHostPath(worktreePath, { platform: 'win32' })).toBeNull()
  })

  it('maps a drvfs worktree to its drive spelling on a Windows host', () => {
    expect(resolveWorktreeHostPath('/mnt/c/Users/me/repo/feature', { platform: 'win32' })).toBe(
      String.raw`C:\Users\me\repo\feature`
    )
  })

  it('maps a guest worktree through a caller-named distro', () => {
    expect(
      resolveWorktreeHostPath('/home/me/repo/feature', { platform: 'win32', wslDistro: 'Ubuntu' })
    ).toBe(String.raw`\\wsl.localhost\Ubuntu\home\me\repo\feature`)
  })

  it('keeps a guest worktree verbatim on Windows when no distro names it', () => {
    expect(resolveWorktreeHostPath('/home/me/repo/feature', { platform: 'win32' })).toBe(
      '/home/me/repo/feature'
    )
  })

  it('ignores a caller-named distro on a POSIX host', () => {
    expect(
      resolveWorktreeHostPath('/home/me/repo/feature', { platform: 'linux', wslDistro: 'Ubuntu' })
    ).toBe('/home/me/repo/feature')
    expect(
      resolveWorktreeHostPath('/mnt/c/repo/feature', { platform: 'darwin', wslDistro: 'Ubuntu' })
    ).toBe('/mnt/c/repo/feature')
  })

  // `//x` is a host UNC spelling, not a guest path: translating it would prepend a second share.
  // A relative path is deliberately absent: the wrapper resolves one against the cwd.
  it.each([
    String.raw`C:\Users\me\repo\feature`,
    String.raw`\\wsl.localhost\Ubuntu\home\me\repo\feature`,
    '//wsl.localhost/Ubuntu/home/me/repo/feature'
  ])('leaves a non-guest worktree path untouched: %j', (worktreePath) => {
    expect(resolveWorktreeHostPath(worktreePath, { platform: 'win32', wslDistro: 'Ubuntu' })).toBe(
      worktreePath
    )
  })
})
