import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import {
  resolveTerminalStartupCwd,
  resolveTerminalStartupCwdForWorkspace
} from './terminal-startup-cwd'
import { folderWorkspaceKey } from './workspace-scope'

describe('resolveTerminalStartupCwd', () => {
  it('accepts absolute child paths inside the worktree', () => {
    expect(resolveTerminalStartupCwd('/repo/app', '/repo/app/packages/web')).toBe(
      '/repo/app/packages/web'
    )
  })

  it('resolves relative paths against the worktree', () => {
    expect(resolveTerminalStartupCwd('/repo/app', 'packages/web')).toBe('/repo/app/packages/web')
  })

  it('allows absolute cwds outside the worktree (#7685)', () => {
    // Why: opening/splitting a terminal outside the worktree (e.g. after
    // `cd ..`) is allowed; the cwd is resolved, not constrained.
    expect(resolveTerminalStartupCwd('/repo/app', '/repo/app-other')).toBe('/repo/app-other')
  })

  it('resolves parent traversal to a path outside the worktree (#7685)', () => {
    expect(resolveTerminalStartupCwd('/repo/app', '../other')).toBe('/repo/other')
  })

  it('trims whitespace-padded requested cwds before resolving', () => {
    expect(resolveTerminalStartupCwd('/repo/app', ' packages/web ')).toBe('/repo/app/packages/web')
  })

  it('returns undefined for an empty requested cwd', () => {
    expect(resolveTerminalStartupCwd('/repo/app', '')).toBeUndefined()
    expect(resolveTerminalStartupCwd('/repo/app', '   ')).toBeUndefined()
    expect(resolveTerminalStartupCwd('/repo/app', null)).toBeUndefined()
  })

  it('normalizes Windows separators and allows out-of-worktree drives', () => {
    expect(resolveTerminalStartupCwd('C:\\Repo\\App', 'packages\\web')).toBe(
      'C:/Repo/App/packages/web'
    )
    expect(resolveTerminalStartupCwd('C:\\Repo\\App', 'C:\\Repo\\AppOther')).toBe(
      'C:/Repo/AppOther'
    )
  })

  it('resolves renderer PTY cwd values against raw worktree IDs', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app/packages/web'
      })
    ).toBe('/repo/app/packages/web')
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app-other'
      })
    ).toBe('/repo/app-other')
  })

  it('passes floating terminal cwds through untouched', () => {
    // Why: floating terminal cwds are validated against trusted-directory
    // grants in main and have no worktree root to resolve against.
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        requestedCwd: '/Volumes/work/notes'
      })
    ).toBe('/Volumes/work/notes')
  })

  it('falls back to the provider default when no workspace root is resolvable', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: undefined,
        requestedCwd: '/anywhere'
      })
    ).toBeUndefined()
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'opaque-worktree-id',
        requestedCwd: '/anywhere'
      })
    ).toBeUndefined()
  })

  it('resolves renderer PTY cwd values against folder workspace keys', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: folderWorkspaceKey('folder-1'),
        requestedCwd: 'packages/web',
        resolveFolderWorkspacePath: (id) => (id === 'folder-1' ? '/repo/app' : null)
      })
    ).toBe('/repo/app/packages/web')
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: folderWorkspaceKey('folder-1'),
        requestedCwd: '../other',
        resolveFolderWorkspacePath: (id) => (id === 'folder-1' ? '/repo/app' : null)
      })
    ).toBe('/repo/other')
  })
})
