import { describe, expect, it } from 'vitest'
import { resolveGitMetadataPath, resolveWorktreeHostPath } from './git-metadata-path'

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

  // Forward-slash UNC gitdirs are already host paths; translation would prepend the share twice.
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
})

describe('resolveWorktreeHostPath', () => {
  // Gitfile payloads end with newlines; directory-name whitespace is real and must survive.
  it.each(['/repo/my feature ', ' /repo/my feature'])(
    'keeps whitespace that belongs to the directory name (%j)',
    (worktreePath) => {
      expect(resolveWorktreeHostPath(worktreePath, { platform: 'linux' })).toBe(worktreePath)
      expect(resolveWorktreeHostPath(worktreePath, { platform: 'win32' })).toBe(worktreePath)
    }
  )
})
