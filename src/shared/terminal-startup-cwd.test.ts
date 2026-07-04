import { describe, expect, it } from 'vitest'
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

  it('rejects sibling paths outside the worktree', () => {
    expect(() => resolveTerminalStartupCwd('/repo/app', '/repo/app-other')).toThrow(
      'Terminal cwd must be inside the selected worktree.'
    )
  })

  it('rejects parent traversal outside the worktree', () => {
    expect(() => resolveTerminalStartupCwd('/repo/app', '../other')).toThrow(
      'Terminal cwd must be inside the selected worktree.'
    )
  })

  it('returns undefined for blank cwd input', () => {
    expect(resolveTerminalStartupCwd('/repo/app', '   ')).toBeUndefined()
  })

  it('falls back to the worktree root for an outside cwd when requested', () => {
    expect(
      resolveTerminalStartupCwd('/repo/app', '/var/tmp/orca-stale', {
        outsideWorktreeCwd: 'fallback-to-worktree'
      })
    ).toBe('/repo/app')
  })

  it('keeps nested cwd resolution unchanged with fallback enabled', () => {
    expect(
      resolveTerminalStartupCwd('/repo/app', '/repo/app/packages/web', {
        outsideWorktreeCwd: 'fallback-to-worktree'
      })
    ).toBe('/repo/app/packages/web')
  })

  it('handles Windows path containment without case drift', () => {
    expect(resolveTerminalStartupCwd('C:\\Repo\\App', 'packages\\web')).toBe(
      'C:/Repo/App/packages/web'
    )
    expect(() => resolveTerminalStartupCwd('C:\\Repo\\App', 'C:\\Repo\\AppOther')).toThrow(
      'Terminal cwd must be inside the selected worktree.'
    )
  })

  it('validates renderer PTY cwd values against raw worktree IDs', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app/packages/web'
      })
    ).toBe('/repo/app/packages/web')
    expect(() =>
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app-other'
      })
    ).toThrow('Terminal cwd must be inside the selected worktree.')
  })

  it('falls back to the raw worktree root for stale renderer cwd values', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/var/tmp/orca-stale',
        outsideWorktreeCwd: 'fallback-to-worktree'
      })
    ).toBe('/repo/app')
  })

  it('validates renderer PTY cwd values against folder workspace keys', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: folderWorkspaceKey('folder-1'),
        requestedCwd: 'packages/web',
        resolveFolderWorkspacePath: (id) => (id === 'folder-1' ? '/repo/app' : null)
      })
    ).toBe('/repo/app/packages/web')
    expect(() =>
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: folderWorkspaceKey('folder-1'),
        requestedCwd: '../other',
        resolveFolderWorkspacePath: (id) => (id === 'folder-1' ? '/repo/app' : null)
      })
    ).toThrow('Terminal cwd must be inside the selected worktree.')
  })

  it('falls back to a resolved folder workspace root for stale cwd values', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: folderWorkspaceKey('folder-1'),
        requestedCwd: '../other',
        resolveFolderWorkspacePath: (id) => (id === 'folder-1' ? '/repo/app' : null),
        outsideWorktreeCwd: 'fallback-to-worktree'
      })
    ).toBe('/repo/app')
  })
})
