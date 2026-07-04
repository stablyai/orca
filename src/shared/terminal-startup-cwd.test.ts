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

  it('trims whitespace-padded requested cwds before resolving', () => {
    expect(resolveTerminalStartupCwd('/repo/app', ' packages/web ')).toBe('/repo/app/packages/web')
  })

  it('falls back to the default cwd when a symlink escapes the worktree', () => {
    const canonicalize = (path: string): string | null =>
      path === '/repo/app/link' ? '/outside/target' : path
    expect(
      resolveTerminalStartupCwd('/repo/app', 'link', { canonicalizePath: canonicalize })
    ).toBeUndefined()
  })

  it('accepts cwds under a symlinked worktree root', () => {
    const canonicalize = (path: string): string | null => path.replace(/^\/tmp\//, '/private/tmp/')
    expect(
      resolveTerminalStartupCwd('/tmp/repo', 'packages/web', { canonicalizePath: canonicalize })
    ).toBe('/tmp/repo/packages/web')
  })

  it('skips the symlink re-check when a path cannot be canonicalized', () => {
    expect(
      resolveTerminalStartupCwd('/repo/app', 'missing', { canonicalizePath: () => null })
    ).toBe('/repo/app/missing')
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

  it('passes floating terminal cwds through untouched', () => {
    // Why: floating terminal cwds are validated against trusted-directory
    // grants in main and have no worktree root to contain within.
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        requestedCwd: '/Volumes/work/notes'
      })
    ).toBe('/Volumes/work/notes')
  })

  it('refuses the requested cwd when no workspace root is resolvable', () => {
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
})
