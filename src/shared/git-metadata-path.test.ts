import { describe, expect, it } from 'vitest'
import { resolveGitMetadataPath } from './git-metadata-path'

describe('resolveGitMetadataPath', () => {
  it('maps a drvfs pointer to its drive spelling on a Windows host with no distro context', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`C:\Users\me\repo`,
        '/mnt/c/Users/me/repo/.git/worktrees/feature',
        'win32'
      )
    ).toBe(String.raw`C:\Users\me\repo\.git\worktrees\feature`)
  })

  it('maps a drvfs drive root to its drive spelling', () => {
    expect(resolveGitMetadataPath(String.raw`D:\repo`, '/mnt/d', 'win32')).toBe('D:\\')
  })

  it('keeps a non-drvfs guest pointer verbatim when no distro names it', () => {
    // Windows already reads this as drive-relative; guessing a distro would probe the wrong disk.
    expect(resolveGitMetadataPath(String.raw`C:\repo`, '/home/me/repo/.git', 'win32')).toBe(
      '/home/me/repo/.git'
    )
  })

  it('maps a guest pointer through the distro encoded by a WSL UNC base', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Debian\home\me\repo`,
        '/home/me/repo/.git',
        'win32'
      )
    ).toBe(String.raw`\\wsl.localhost\Debian\home\me\repo\.git`)
  })

  it('resolves a relative pointer against a WSL UNC base', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Debian\home\me\repo\.git\worktrees\feature`,
        '../..',
        'win32'
      )
    ).toBe(String.raw`\\wsl.localhost\Debian\home\me\repo\.git`)
  })

  it('resolves relative pointers with the reading host path flavor', () => {
    expect(resolveGitMetadataPath('/repo/worktree', '../.git/worktrees/feature', 'linux')).toBe(
      '/repo/.git/worktrees/feature'
    )
    expect(
      resolveGitMetadataPath(
        String.raw`C:\repo\worktree`,
        String.raw`..\.git\worktrees\feature`,
        'win32'
      )
    ).toBe(String.raw`C:\repo\.git\worktrees\feature`)
  })

  it('leaves absolute pointers alone on a POSIX host, drvfs spelling included', () => {
    expect(
      resolveGitMetadataPath('/repo/worktree', '/var/lib/git/worktrees/feature', 'linux')
    ).toBe('/var/lib/git/worktrees/feature')
    expect(resolveGitMetadataPath('/repo/worktree', '/mnt/c/repo/.git', 'darwin')).toBe(
      '/mnt/c/repo/.git'
    )
  })

  it.each(['', '   ', '\t'])('rejects an empty metadata pointer %j', (rawPath) => {
    expect(resolveGitMetadataPath('/repo', rawPath, 'linux')).toBeNull()
  })

  it('trims a padded pointer before resolving it', () => {
    expect(resolveGitMetadataPath('/repo/worktree', '  ../.git  ', 'linux')).toBe('/repo/.git')
  })
})
