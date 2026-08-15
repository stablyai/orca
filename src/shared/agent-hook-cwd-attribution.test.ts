import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hookCwdContradictsWorktree,
  hookCwdContradictsWorktreeAfterLocalResolve
} from './agent-hook-cwd-attribution'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from './worktree/id'

const REPO = 'repo-1'
const WORKTREE = `${REPO}::/Users/dev/projects/api`

describe('hookCwdContradictsWorktree', () => {
  it('accepts a session running at or under the reported worktree', () => {
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api/')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api/src/server')).toBe(false)
  })

  it('rejects a session whose cwd lies outside the reported worktree', () => {
    // Why: the daemon-inherited env case — a session in one project reporting another's pane.
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/agent')).toBe(true)
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api-two')).toBe(true)
  })

  it('accepts a worktree nested under the session cwd', () => {
    // Why: folder workspaces can sit below the directory the agent was started in.
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, '/')).toBe(false)
  })

  it('stays quiet when either side is missing or unparseable', () => {
    expect(hookCwdContradictsWorktree(undefined, '/Users/dev/projects/agent')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, undefined)).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, '')).toBe(false)
    // Worktree ids without the `::` separator carry no path to compare.
    expect(hookCwdContradictsWorktree('onboarding-inline-terminal', '/Users/dev/x')).toBe(false)
    expect(hookCwdContradictsWorktree(`${REPO}::`, '/Users/dev/x')).toBe(false)
    // Relative and untrimmed cwds have no comparable root.
    expect(hookCwdContradictsWorktree(WORKTREE, 'projects/agent')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, ' /Users/dev/projects/agent')).toBe(false)
  })

  it('ignores case and trailing separators when comparing', () => {
    expect(hookCwdContradictsWorktree(WORKTREE, '/users/dev/projects/API/src')).toBe(false)
    expect(
      hookCwdContradictsWorktree(`${REPO}::/Users/dev/projects/api/`, '/Users/dev/projects/api')
    ).toBe(false)
  })

  it('treats canonically equivalent non-ASCII paths as the same directory', () => {
    // Why: the folder picker stores NFD on macOS while agents report cwd in NFC, so a
    // byte comparison would drop every status from a non-ASCII workspace (#10832).
    const folder = '/Users/dev/projects/한글'
    expect(
      hookCwdContradictsWorktree(
        `${REPO}::${folder.normalize('NFD')}`,
        `${folder.normalize('NFC')}/src`
      )
    ).toBe(false)
  })

  it('compares Windows worktrees against Windows cwds', () => {
    const windowsWorktree = `${REPO}::C:\\Users\\dev\\api`
    expect(hookCwdContradictsWorktree(windowsWorktree, 'C:\\Users\\dev\\api\\src')).toBe(false)
    expect(hookCwdContradictsWorktree(windowsWorktree, 'C:/Users/dev/agent')).toBe(true)
  })

  it('treats a drive root as sitting above every path on that drive', () => {
    expect(hookCwdContradictsWorktree(`${REPO}::C:\\Users\\dev`, 'C:\\..')).toBe(false)
    expect(hookCwdContradictsWorktree(`${REPO}::C:\\`, 'C:\\Users\\dev')).toBe(false)
  })

  it('resolves dot segments so a path cannot pose as being inside the worktree', () => {
    // Why: `…/api/../agent` starts with the worktree path as plain text but resolves outside it.
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api/../agent')).toBe(true)
    expect(
      hookCwdContradictsWorktree(`${REPO}::C:\\Users\\dev\\api`, 'C:\\Users\\dev\\api\\..\\agent')
    ).toBe(true)
    // Dot segments that stay inside, or that only spell the worktree a longer way, are not conflicts.
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api/./src')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, '/Users/dev/projects/api/src/../lib')).toBe(false)
    expect(
      hookCwdContradictsWorktree(`${REPO}::/Users/dev/projects/x/../api`, '/Users/dev/projects/api')
    ).toBe(false)
    // Popping past the root lands on the root, which every worktree sits under.
    expect(hookCwdContradictsWorktree(WORKTREE, '/../../..')).toBe(false)
  })

  it('refuses to judge across notations a single host can express two ways', () => {
    // WSL reports the POSIX mount for a drive-rooted worktree, and UNC names the same
    // directory a third way — a mapped drive or a distro share.
    expect(hookCwdContradictsWorktree(`${REPO}::C:\\Users\\dev\\api`, '/mnt/c/Users/dev/api')).toBe(
      false
    )
    expect(
      hookCwdContradictsWorktree(
        `${REPO}::C:\\Users\\dev\\api`,
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\dev\\api'
      )
    ).toBe(false)
    expect(
      hookCwdContradictsWorktree(`${REPO}::\\\\wsl$\\Ubuntu\\home\\dev\\api`, '/home/dev/api')
    ).toBe(false)
    expect(
      hookCwdContradictsWorktree(`${REPO}::/home/dev/api`, '\\\\wsl$\\Ubuntu\\home\\dev\\x')
    ).toBe(false)
    expect(hookCwdContradictsWorktree(`${REPO}::C:\\..\\..`, '/Users/dev/projects/api')).toBe(false)
    expect(hookCwdContradictsWorktree(WORKTREE, 'C:\\..\\..')).toBe(false)
  })

  it('compares the real folder path of a folder-workspace instance id', () => {
    const instanceId = '11111111-2222-4333-8444-555555555555'
    const folderWorkspace = `${REPO}::/Users/dev/notes${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
    expect(hookCwdContradictsWorktree(folderWorkspace, '/Users/dev/notes/inbox')).toBe(false)
    expect(hookCwdContradictsWorktree(folderWorkspace, '/Users/dev/projects/api')).toBe(true)
  })
})

describe('hookCwdContradictsWorktreeAfterLocalResolve', () => {
  it('clears a contradiction that is only symlink aliasing of the same directory', () => {
    // Why: Orca stores the path as picked while agents report physical getcwd — macOS /tmp
    // is /private/tmp, project roots sit behind symlinks — so raw strings can be fully
    // disjoint for one directory and the guard must not read that as a foreign session.
    const base = mkdtempSync(join(tmpdir(), 'orca-cwd-attr-'))
    try {
      const real = join(base, 'real-workspace')
      mkdirSync(join(real, 'src'), { recursive: true })
      const link = join(base, 'linked-workspace')
      try {
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        return // Restricted hosts that cannot create links have nothing to verify here.
      }
      const physicalSessionCwd = join(realpathSync(real), 'src')
      expect(hookCwdContradictsWorktree(`${REPO}::${link}`, physicalSessionCwd)).toBe(true)
      expect(
        hookCwdContradictsWorktreeAfterLocalResolve(`${REPO}::${link}`, physicalSessionCwd)
      ).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('clears the mirror alias where the session cwd is the symlinked spelling', () => {
    // Why: the alias can sit on either side — a logical $PWD-style cwd against a physically
    // stored worktree needs the cwd side resolved, not just the worktree side.
    const base = mkdtempSync(join(tmpdir(), 'orca-cwd-attr-'))
    try {
      const real = join(base, 'real-workspace')
      mkdirSync(join(real, 'src'), { recursive: true })
      const link = join(base, 'linked-workspace')
      try {
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        return // Restricted hosts that cannot create links have nothing to verify here.
      }
      const physicalWorktree = realpathSync(real)
      const linkSpelledCwd = join(link, 'src')
      expect(hookCwdContradictsWorktree(`${REPO}::${physicalWorktree}`, linkSpelledCwd)).toBe(true)
      expect(
        hookCwdContradictsWorktreeAfterLocalResolve(`${REPO}::${physicalWorktree}`, linkSpelledCwd)
      ).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('treats the macOS data-volume firmlink spelling as the same directory', () => {
    // Why: firmlinks are not symlinks — realpath keeps /System/Volumes/Data/… even though it
    // names the same directory, so resolution alone cannot rescue a firmlink-spelled workspace.
    const base = mkdtempSync(join(tmpdir(), 'orca-cwd-attr-'))
    try {
      const physical = realpathSync(base)
      const firmlinkSpelled = `/System/Volumes/Data${physical}`
      if (process.platform !== 'darwin' || !existsSync(firmlinkSpelled)) {
        return // The alias only exists on macOS data-volume layouts.
      }
      mkdirSync(join(physical, 'ws', 'src'), { recursive: true })
      expect(
        hookCwdContradictsWorktree(`${REPO}::${firmlinkSpelled}/ws`, join(physical, 'ws', 'src'))
      ).toBe(true)
      expect(
        hookCwdContradictsWorktreeAfterLocalResolve(
          `${REPO}::${firmlinkSpelled}/ws`,
          join(physical, 'ws', 'src')
        )
      ).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('still refuses genuinely disjoint real directories', () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-cwd-attr-'))
    try {
      const workspace = join(base, 'workspace-a')
      const session = join(base, 'session-b')
      mkdirSync(workspace)
      mkdirSync(session)
      expect(hookCwdContradictsWorktreeAfterLocalResolve(`${REPO}::${workspace}`, session)).toBe(
        true
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('keeps the raw verdict for paths that do not exist on this host', () => {
    // Why: remote (SSH/WSL) paths fail existsSync here, so the string verdict must stand —
    // the relay that owns those paths runs its own resolved check before forwarding.
    expect(
      hookCwdContradictsWorktreeAfterLocalResolve(
        `${REPO}::/nonexistent-orca-guard-test/worktree-a`,
        '/nonexistent-orca-guard-test/session-b'
      )
    ).toBe(true)
    expect(
      hookCwdContradictsWorktreeAfterLocalResolve(WORKTREE, '/Users/dev/projects/api/src')
    ).toBe(false)
  })
})
