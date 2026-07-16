import { describe, expect, it, vi } from 'vitest'
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

  it('falls back to the workspace root when the requested cwd directory is missing', () => {
    const onFallbackToWorkspaceRoot = vi.fn()
    expect(
      resolveTerminalStartupCwd('/repo/app', '/repo/app/deleted-folder', {
        directoryExists: (path) => path === '/repo/app',
        onFallbackToWorkspaceRoot
      })
    ).toBe('/repo/app')
    expect(onFallbackToWorkspaceRoot).toHaveBeenCalledWith('/repo/app/deleted-folder')
  })

  it('falls back to a non-ASCII workspace root for a missing cwd (#7239)', () => {
    // Why: issue #7239 reproduced in a Japanese-named worktree; the fallback
    // must preserve the selected worktree path verbatim.
    const worktreePath = '/Users/motoki/orca/workspaces/nakamuramotoki/Fableと議論'
    expect(
      resolveTerminalStartupCwd(worktreePath, '/var/tmp/orca-stale', {
        directoryExists: (path) => path === worktreePath
      })
    ).toBe(worktreePath)
  })

  it('keeps an existing cwd outside the worktree when fallback is enabled (#7685)', () => {
    const onFallbackToWorkspaceRoot = vi.fn()
    expect(
      resolveTerminalStartupCwd('/repo/app', '/repo/app-other', {
        directoryExists: () => true,
        onFallbackToWorkspaceRoot
      })
    ).toBe('/repo/app-other')
    expect(onFallbackToWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('keeps an existing nested cwd when fallback is enabled', () => {
    const onFallbackToWorkspaceRoot = vi.fn()
    expect(
      resolveTerminalStartupCwd('/repo/app', 'packages/web', {
        directoryExists: () => true,
        onFallbackToWorkspaceRoot
      })
    ).toBe('/repo/app/packages/web')
    expect(onFallbackToWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('keeps the requested cwd when the workspace root is missing too', () => {
    // Why: unmounted volume / stopped WSL distro — falling back would spawn a
    // misleading shell; let the provider surface its normal error instead.
    const onFallbackToWorkspaceRoot = vi.fn()
    expect(
      resolveTerminalStartupCwd('/repo/app', '/repo/app/deleted-folder', {
        directoryExists: () => false,
        onFallbackToWorkspaceRoot
      })
    ).toBe('/repo/app/deleted-folder')
    expect(onFallbackToWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('does not probe when the requested cwd resolves to the workspace root', () => {
    const directoryExists = vi.fn(() => false)
    expect(
      resolveTerminalStartupCwd('/repo/app', '/repo/app', {
        directoryExists,
        onFallbackToWorkspaceRoot: () => {}
      })
    ).toBe('/repo/app')
    expect(directoryExists).not.toHaveBeenCalled()
  })

  it('falls back from a missing parent-traversal cwd to the workspace root', () => {
    expect(
      resolveTerminalStartupCwd('/repo/app', '../deleted', {
        directoryExists: (path) => path === '/repo/app'
      })
    ).toBe('/repo/app')
  })

  it('recovers missing renderer cwd values against raw worktree IDs', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app/deleted-folder',
        missingDirFallback: {
          directoryExists: (path) => path === '/repo/app'
        }
      })
    ).toBe('/repo/app')
  })

  it('recovers missing cwd values against a resolved folder workspace root', () => {
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: folderWorkspaceKey('folder-1'),
        requestedCwd: 'deleted-folder',
        resolveFolderWorkspacePath: (id) => (id === 'folder-1' ? '/repo/app' : null),
        missingDirFallback: {
          directoryExists: (path) => path === '/repo/app'
        }
      })
    ).toBe('/repo/app')
  })

  it('never probes floating terminal cwds', () => {
    const directoryExists = vi.fn(() => false)
    expect(
      resolveTerminalStartupCwdForWorkspace({
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        requestedCwd: '/Volumes/work/notes',
        missingDirFallback: { directoryExists }
      })
    ).toBe('/Volumes/work/notes')
    expect(directoryExists).not.toHaveBeenCalled()
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
