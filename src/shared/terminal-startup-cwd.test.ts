import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import {
  requestsCwdOutsideWorkspaceRoot,
  requestsCwdOutsideWorkspaceRootForWorkspace,
  resolveTerminalStartupCwd,
  resolveTerminalStartupCwdForWorkspace
} from './terminal-startup-cwd'
import { folderWorkspaceKey } from './workspace-scope'

describe('resolveTerminalStartupCwd', () => {
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
    // Preserve the Japanese workspace path from the #7239 reproduction verbatim.
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
    // An unmounted volume/stopped WSL distro should surface the provider error, not spawn a misleading fallback shell.
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
})

describe('requestsCwdOutsideWorkspaceRoot', () => {
  it.each([
    ['the root itself', '/repo/app', '/repo/app'],
    ['the root with a trailing slash', '/repo/app', '/repo/app/'],
    ['the root as a relative dot', '/repo/app', '.'],
    ['a relative path that lands back on the root', '/repo/app', 'packages/..'],
    ['a Windows root spelled with forward slashes', 'C:\\repo\\app', 'C:/repo/app/'],
    ['a Windows root in another case', 'C:\\Repo\\App', 'c:\\repo\\app'],
    [
      'the other WSL UNC alias of the root',
      '\\\\wsl$\\Ubuntu\\home\\ada\\app',
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\app\\'
    ],
    ['an SSH-side root spelled with a trailing slash', '/home/ada/app', '/home/ada/app//'],
    [
      'a WSL root spelled as its Linux path',
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\app',
      '/home/ada/app/'
    ]
  ])('reads %s as no custom cwd', (_name, root, cwd) => {
    expect(requestsCwdOutsideWorkspaceRoot(root, cwd)).toBe(false)
  })

  it.each([
    ['a subdirectory', '/repo/app', '/repo/app/packages/web'],
    ['a relative subdirectory', '/repo/app', 'packages/web'],
    ['a directory outside the root', '/repo/app', '/repo/other'],
    [
      'a POSIX root in another case, which is a different directory',
      '/home/ada/app',
      '/home/Ada/app'
    ],
    [
      'a Linux subdirectory of a WSL root',
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\app',
      '/home/ada/app/src'
    ]
  ])('reads %s as a custom cwd', (_name, root, cwd) => {
    expect(requestsCwdOutsideWorkspaceRoot(root, cwd)).toBe(true)
  })

  it('reads a cwd against an unknown root as custom, because it cannot prove otherwise', () => {
    expect(requestsCwdOutsideWorkspaceRoot(undefined, '/repo/app')).toBe(true)
  })
})

describe('requestsCwdOutsideWorkspaceRootForWorkspace', () => {
  it('takes the root from the caller when it has one, else from the worktree id', () => {
    expect(
      requestsCwdOutsideWorkspaceRootForWorkspace({
        workspaceId: 'wt-1',
        workspacePath: '/repo/app',
        requestedCwd: '/repo/app/'
      })
    ).toBe(false)
    expect(
      requestsCwdOutsideWorkspaceRootForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app'
      })
    ).toBe(false)
    expect(
      requestsCwdOutsideWorkspaceRootForWorkspace({
        workspaceId: 'repo-1::/repo/app',
        requestedCwd: '/repo/app/packages/web'
      })
    ).toBe(true)
  })

  it('resolves a folder workspace root through the caller', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const resolveFolderWorkspacePath = (id: string) => (id === 'folder-1' ? '/srv/notes' : null)
    expect(
      requestsCwdOutsideWorkspaceRootForWorkspace({
        workspaceId,
        requestedCwd: '/srv/notes/',
        resolveFolderWorkspacePath
      })
    ).toBe(false)
    expect(
      requestsCwdOutsideWorkspaceRootForWorkspace({
        workspaceId,
        requestedCwd: '/srv/notes/drafts',
        resolveFolderWorkspacePath
      })
    ).toBe(true)
  })

  it('reads any cwd in the floating workspace as custom, since it has no root', () => {
    expect(
      requestsCwdOutsideWorkspaceRootForWorkspace({
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        requestedCwd: '/tmp'
      })
    ).toBe(true)
  })
})
