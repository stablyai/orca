import { describe, expect, it } from 'vitest'
import { isWorktreePathAdmissibleForHost } from './worktree-host-path-admissibility'

describe('isWorktreePathAdmissibleForHost', () => {
  describe('Windows host', () => {
    const windowsRepo = { path: 'C:/Users/user/project' }

    it('accepts Windows absolute, UNC, and WSL UNC paths', () => {
      for (const path of [
        'C:/Users/user/project/feature-1',
        'd:\\code\\project\\feature-2',
        '\\\\server\\share\\repo\\wt',
        '\\\\wsl.localhost\\Ubuntu\\home\\user\\wt'
      ]) {
        expect(isWorktreePathAdmissibleForHost(path, windowsRepo, 'linux')).toBe(true)
      }
    })

    it('rejects POSIX, relative, and empty paths', () => {
      for (const path of ['/workspaces/project/seacucumber', 'relative/feature', '']) {
        expect(isWorktreePathAdmissibleForHost(path, windowsRepo, 'win32')).toBe(false)
      }
    })

    it('rejects paths inside a git admin dir but keeps a bare repo entry', () => {
      expect(
        isWorktreePathAdmissibleForHost('C:/Users/user/project/.git/worktrees/feat', windowsRepo)
      ).toBe(false)
      expect(isWorktreePathAdmissibleForHost('C:/Users/user/project/.git', windowsRepo)).toBe(true)
    })
  })

  describe('POSIX host', () => {
    const linuxRepo = { path: '/workspaces/project' }

    it('accepts POSIX absolute paths, including legal `:` and `\\` characters', () => {
      for (const path of [
        '/workspaces/project/seacucumber',
        '/workspaces/project/a:b',
        '/workspaces/project/a\\b'
      ]) {
        expect(isWorktreePathAdmissibleForHost(path, linuxRepo, 'win32')).toBe(true)
      }
    })

    it('rejects Windows, UNC, and WSL UNC paths', () => {
      for (const path of [
        'C:/Users/user/project/sockeye',
        'C:\\Users\\user\\project\\sockeye',
        '\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\feat',
        '//wsl.localhost/Ubuntu/home/user/project/feat'
      ]) {
        expect(isWorktreePathAdmissibleForHost(path, linuxRepo, 'linux')).toBe(false)
      }
    })

    it('rejects a foreign registration joined onto a bare common dir', () => {
      expect(
        isWorktreePathAdmissibleForHost('/srv/repo.git/worktrees/wt/C:/Users/alice/wt', linuxRepo)
      ).toBe(false)
    })

    it('treats `\\` in a POSIX name as a character, not a separator', () => {
      expect(isWorktreePathAdmissibleForHost('/srv/a\\.git\\b/wt', linuxRepo)).toBe(true)
    })

    it('rejects a foreign registration joined onto .git/worktrees', () => {
      expect(
        isWorktreePathAdmissibleForHost(
          '/workspaces/project/.git/worktrees/28712-abc/C:/Users/user/orca/workspaces/project/sockeye',
          linuxRepo,
          'linux'
        )
      ).toBe(false)
    })
  })

  describe('host identity', () => {
    it('classifies SSH and runtime hosts by their own repo path, not the client platform', () => {
      for (const target of [
        { path: '/srv/orca', executionHostId: 'runtime:linux-env' },
        { path: '/workspaces/project', connectionId: 'dev-container' },
        { path: '/workspaces/project', hostId: 'ssh:dev-container' }
      ]) {
        expect(isWorktreePathAdmissibleForHost('/srv/orca/feat', target, 'win32')).toBe(true)
        expect(isWorktreePathAdmissibleForHost('C:/srv/orca/feat', target, 'win32')).toBe(false)
      }
      const windowsRuntime = { path: 'C:/orca', executionHostId: 'runtime:win-env' }
      expect(isWorktreePathAdmissibleForHost('C:/orca/feat', windowsRuntime, 'darwin')).toBe(true)
      expect(isWorktreePathAdmissibleForHost('/orca/feat', windowsRuntime, 'darwin')).toBe(false)
    })

    it('treats a WSL repo as a WSL host and accepts its POSIX, UNC, and drive spellings', () => {
      const wslRepo = { path: '//wsl.localhost/Ubuntu/home/user/project' }
      expect(isWorktreePathAdmissibleForHost('/home/user/project/feat', wslRepo, 'win32')).toBe(
        true
      )
      expect(
        isWorktreePathAdmissibleForHost(
          '\\\\wsl.localhost\\Ubuntu\\home\\user\\wt',
          wslRepo,
          'win32'
        )
      ).toBe(true)
      // A /mnt/c worktree reaches here translated back to its drive spelling.
      expect(isWorktreePathAdmissibleForHost('C:\\trees\\feature', wslRepo, 'win32')).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          '\\\\wsl.localhost\\Ubuntu\\srv\\repo.git\\worktrees\\wt\\C:\\Users\\alice\\wt',
          wslRepo,
          'win32'
        )
      ).toBe(false)
    })

    it('uses the client platform only for a local host without a classifiable repo path', () => {
      expect(isWorktreePathAdmissibleForHost('/repo/feat', { path: '' }, 'win32')).toBe(false)
      expect(isWorktreePathAdmissibleForHost('/repo/feat', { path: '' }, 'linux')).toBe(true)
      // An SSH host's OS is unknown without its path, so nothing is rejected on host grounds.
      expect(
        isWorktreePathAdmissibleForHost('C:/repo/feat', { path: '', hostId: 'ssh:box' }, 'linux')
      ).toBe(true)
    })
  })
})
