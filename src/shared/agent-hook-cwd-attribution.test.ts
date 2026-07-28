import { describe, expect, it } from 'vitest'
import { hookCwdContradictsWorktree, readHookPayloadCwd } from './agent-hook-cwd-attribution'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from './worktree-id'

const REPO = 'repo-1'
const WORKTREE = `${REPO}::/Users/dev/projects/api`

describe('readHookPayloadCwd', () => {
  it('reads the cwd variants agents report, and nothing else', () => {
    expect(readHookPayloadCwd({ cwd: '/Users/dev/projects/api' })).toBe('/Users/dev/projects/api')
    expect(readHookPayloadCwd({ workspaceRoot: '/srv/app' })).toBe('/srv/app')
    expect(readHookPayloadCwd({ workspace_root: '/srv/app' })).toBe('/srv/app')
    expect(readHookPayloadCwd({ cwd: '   ' })).toBeUndefined()
    expect(readHookPayloadCwd({ cwd: 42 })).toBeUndefined()
    expect(readHookPayloadCwd(null)).toBeUndefined()
    expect(readHookPayloadCwd('/srv/app')).toBeUndefined()
  })
})

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
    // Relative cwd has no comparable root.
    expect(hookCwdContradictsWorktree(WORKTREE, 'projects/agent')).toBe(false)
  })

  it('ignores case and trailing separators when comparing', () => {
    expect(hookCwdContradictsWorktree(WORKTREE, '/users/dev/projects/API/src')).toBe(false)
    expect(
      hookCwdContradictsWorktree(`${REPO}::/Users/dev/projects/api/`, '/Users/dev/projects/api')
    ).toBe(false)
  })

  it('compares Windows worktrees against Windows cwds', () => {
    const windowsWorktree = `${REPO}::C:\\Users\\dev\\api`
    expect(hookCwdContradictsWorktree(windowsWorktree, 'C:\\Users\\dev\\api\\src')).toBe(false)
    expect(hookCwdContradictsWorktree(windowsWorktree, 'C:/Users/dev/agent')).toBe(true)
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
    // WSL reports the POSIX mount for a drive-rooted worktree, and UNC paths name the distro.
    expect(hookCwdContradictsWorktree(`${REPO}::C:\\Users\\dev\\api`, '/mnt/c/Users/dev/api')).toBe(
      false
    )
    expect(
      hookCwdContradictsWorktree(`${REPO}::\\\\wsl$\\Ubuntu\\home\\dev\\api`, '/home/dev/api')
    ).toBe(false)
    expect(
      hookCwdContradictsWorktree(`${REPO}::/home/dev/api`, '\\\\wsl$\\Ubuntu\\home\\dev\\x')
    ).toBe(false)
  })

  it('compares the real folder path of a folder-workspace instance id', () => {
    const instanceId = '11111111-2222-4333-8444-555555555555'
    const folderWorkspace = `${REPO}::/Users/dev/notes${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
    expect(hookCwdContradictsWorktree(folderWorkspace, '/Users/dev/notes/inbox')).toBe(false)
    expect(hookCwdContradictsWorktree(folderWorkspace, '/Users/dev/projects/api')).toBe(true)
  })
})
