import { describe, expect, it } from 'vitest'
import { resolveTerminalDropTargetShell } from './terminal-drop-shell'

describe('resolveTerminalDropTargetShell', () => {
  it('uses runtime worktree path shape for active Windows runtimes', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: 'env-1',
        worktreePath: '//Server/Share/Repo',
        connectionId: null,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      })
    ).toBe('windows')
  })

  it('uses runtime worktree path shape for active POSIX runtimes', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: 'env-1',
        worktreePath: '/home/orca/repo',
        connectionId: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      })
    ).toBe('posix')
  })

  it('keeps SSH drops POSIX when remote platform metadata is unavailable', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: null,
        worktreePath: 'C:\\repo',
        connectionId: 'ssh-1',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      })
    ).toBe('posix')
  })

  it('uses POSIX shell escaping for local WSL UNC worktrees', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: null,
        worktreePath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo',
        connectionId: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      })
    ).toBe('posix')
  })

  it('uses POSIX shell escaping for relay-era SSH targets', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: null,
        worktreePath: 'C:\\repo',
        connectionId: 'ssh-linux',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      })
    ).toBe('posix')
  })
})
