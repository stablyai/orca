import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGitDirPointerTarget } from './git-worktree-dir'

describe('resolveGitDirPointerTarget', () => {
  it('resolves a relative pointer against the checkout path', () => {
    expect(resolveGitDirPointerTarget('/repos/wt', '../main/.git/worktrees/wt')).toBe(
      path.resolve('/repos/wt', '../main/.git/worktrees/wt')
    )
  })

  it('maps an ext4 pointer of a WSL UNC checkout through its distro', () => {
    expect(
      resolveGitDirPointerTarget(
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt',
        '/home/u/main/.git/worktrees/wt'
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\main\\.git\\worktrees\\wt')
  })

  it('maps a /mnt pointer of a WSL UNC checkout to the Windows drive', () => {
    expect(
      resolveGitDirPointerTarget(
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt',
        '/mnt/c/repos/main/.git/worktrees/wt'
      )
    ).toBe('C:\\repos\\main\\.git\\worktrees\\wt')
  })

  it('maps a drvfs /mnt pointer of a Windows-drive checkout drive-to-drive', () => {
    // git-in-WSL on a drvfs repo writes a Linux pointer while the checkout is C:\...;
    // resolving it against the checkout would land on a nonexistent C:\mnt\... path.
    expect(resolveGitDirPointerTarget('C:\\repos\\wt', '/mnt/c/repos/main/.git/worktrees/wt')).toBe(
      'C:\\repos\\main\\.git\\worktrees\\wt'
    )
  })

  it('keeps an absolute Linux pointer as-is for a Linux checkout', () => {
    expect(resolveGitDirPointerTarget('/home/u/wt', '/mnt/data/main/.git/worktrees/wt')).toBe(
      path.resolve('/home/u/wt', '/mnt/data/main/.git/worktrees/wt')
    )
  })

  it('falls through for a non-mnt Linux pointer on a Windows-drive checkout', () => {
    // Unresolvable without knowing the distro; the probe misses safely.
    expect(resolveGitDirPointerTarget('C:\\repos\\wt', '/home/u/main/.git/worktrees/wt')).toBe(
      path.resolve('C:\\repos\\wt', '/home/u/main/.git/worktrees/wt')
    )
  })
})
