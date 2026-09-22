import { describe, expect, it } from 'vitest'
import { isWorktreePathAdmissibleForHost } from './worktree-host-path-admissibility'

describe('isWorktreePathAdmissibleForHost', () => {
  describe('native Windows host', () => {
    const windowsRepo = { path: 'C:/Users/user/project' }

    it('accepts Windows absolute paths', () => {
      expect(
        isWorktreePathAdmissibleForHost('C:/Users/user/project/feature-1', windowsRepo, 'win32')
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost('d:\\code\\project\\feature-2', windowsRepo, 'win32')
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost('\\\\server\\share\\repo\\wt', windowsRepo, 'win32')
      ).toBe(true)
    })

    it('rejects POSIX root paths on Windows', () => {
      expect(
        isWorktreePathAdmissibleForHost('/workspaces/project/seacucumber', windowsRepo, 'win32')
      ).toBe(false)
      expect(
        isWorktreePathAdmissibleForHost('/home/user/code/feature', windowsRepo, 'win32')
      ).toBe(false)
    })

    it('rejects relative or empty paths', () => {
      expect(isWorktreePathAdmissibleForHost('', windowsRepo, 'win32')).toBe(false)
      expect(isWorktreePathAdmissibleForHost('relative/feature', windowsRepo, 'win32')).toBe(false)
    })

    it('rejects paths inside administrative .git directory', () => {
      expect(
        isWorktreePathAdmissibleForHost(
          'C:/Users/user/project/.git/worktrees/feat',
          windowsRepo,
          'win32'
        )
      ).toBe(false)
    })
  })

  describe('POSIX host (Linux / macOS)', () => {
    const linuxRepo = { path: '/workspaces/project' }

    it('accepts POSIX absolute paths', () => {
      expect(
        isWorktreePathAdmissibleForHost('/workspaces/project/seacucumber', linuxRepo, 'linux')
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost('/home/user/project/feature', linuxRepo, 'darwin')
      ).toBe(true)
    })

    it('rejects Windows drive-letter paths on POSIX host', () => {
      expect(
        isWorktreePathAdmissibleForHost('C:/Users/user/project/sockeye', linuxRepo, 'linux')
      ).toBe(false)
      expect(
        isWorktreePathAdmissibleForHost('C:\\Users\\user\\project\\sockeye', linuxRepo, 'linux')
      ).toBe(false)
    })

    it('rejects joined mangled paths inside .git/worktrees', () => {
      expect(
        isWorktreePathAdmissibleForHost(
          '/workspaces/project/.git/worktrees/28712-abc/C:/Users/user/orca/workspaces/project/sockeye',
          linuxRepo,
          'linux'
        )
      ).toBe(false)
    })

    it('rejects paths containing backslashes on POSIX', () => {
      expect(
        isWorktreePathAdmissibleForHost('/workspaces/project\\feature', linuxRepo, 'linux')
      ).toBe(false)
    })
  })

  describe('Remote SSH host detection', () => {
    it('detects Windows SSH host from Windows repo path', () => {
      const sshWindowsRepo = {
        connectionId: 'win-box',
        path: 'C:/Users/user/project'
      }
      expect(
        isWorktreePathAdmissibleForHost(
          'C:/Users/user/project/feat',
          sshWindowsRepo,
          'darwin' // client platform is macOS
        )
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          '/workspaces/project/feat',
          sshWindowsRepo,
          'darwin'
        )
      ).toBe(false)
    })

    it('detects Linux SSH host from POSIX repo path', () => {
      const sshLinuxRepo = {
        connectionId: 'linux-container',
        path: '/workspaces/project'
      }
      expect(
        isWorktreePathAdmissibleForHost(
          '/workspaces/project/feat',
          sshLinuxRepo,
          'win32' // client platform is Windows
        )
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          'C:/Users/user/project/feat',
          sshLinuxRepo,
          'win32'
        )
      ).toBe(false)
    })
  })

  describe('WSL host support', () => {
    it('treats WSL UNC paths as POSIX-compatible', () => {
      const wslRepo = { path: '//wsl.localhost/Ubuntu/home/user/project' }
      expect(
        isWorktreePathAdmissibleForHost(
          '/home/user/project/feat',
          wslRepo,
          'win32'
        )
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          '//wsl.localhost/Ubuntu/home/user/project/feat',
          wslRepo,
          'win32'
        )
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          '\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\feat',
          wslRepo,
          'win32'
        )
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          '\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\feat',
          { path: '/home/user/project' },
          'linux'
        )
      ).toBe(true)
      expect(
        isWorktreePathAdmissibleForHost(
          'C:/Users/user/project/feat',
          wslRepo,
          'win32'
        )
      ).toBe(false)
    })
  })
})
