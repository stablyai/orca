import { describe, expect, it } from 'vitest'
import {
  resolveTerminalDropInputShell,
  resolveTerminalDropTargetShell
} from './terminal-drop-shell'

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

describe('resolveTerminalDropInputShell', () => {
  function resolve(args: {
    targetShell: 'posix' | 'windows'
    remoteHost?: { runtimeEnvironmentId: string | null } | null
    hostShell?: string | null
    globalShell?: string
    tabShell?: string
    sessionShell?: string
  }) {
    return resolveTerminalDropInputShell({
      targetShell: args.targetShell,
      remoteHost: args.remoteHost ?? null,
      state: {
        settings: { terminalWindowsShell: args.globalShell ?? 'powershell.exe' },
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', shellOverride: args.tabShell }] },
        runtimeStatusByEnvironmentId: new Map<
          string,
          { status: { terminalWindowsShell: string | null } }
        >(
          args.hostShell === undefined
            ? []
            : [['env-1', { status: { terminalWindowsShell: args.hostShell } }]]
        )
      },
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      transport: {
        getLocalSessionMetadata: () =>
          args.sessionShell ? { shellOverride: args.sessionShell } : null
      }
    })
  }

  it('keeps POSIX quoting for POSIX path targets whatever the Windows shell setting', () => {
    expect(resolve({ targetShell: 'posix', globalShell: 'cmd.exe' })).toBe('posix')
  })

  it("quotes for a local Windows pane's configured shell", () => {
    expect(resolve({ targetShell: 'windows' })).toBe('powershell')
    expect(resolve({ targetShell: 'windows', globalShell: 'cmd.exe' })).toBe('cmd')
    expect(resolve({ targetShell: 'windows', globalShell: 'git-bash' })).toBe('posix')
  })

  it("prefers the pane's spawn-time shell, then its tab, over the global setting", () => {
    expect(resolve({ targetShell: 'windows', globalShell: 'cmd.exe', tabShell: 'pwsh.exe' })).toBe(
      'powershell'
    )
    expect(
      resolve({
        targetShell: 'windows',
        tabShell: 'pwsh.exe',
        sessionShell: 'C:\\Windows\\cmd.exe'
      })
    ).toBe('cmd')
  })

  it('uses the shell a Windows runtime host publishes, not this client', () => {
    const remoteHost = { runtimeEnvironmentId: 'env-1' }
    expect(resolve({ targetShell: 'windows', remoteHost, hostShell: 'cmd.exe' })).toBe('cmd')
    expect(
      resolve({
        targetShell: 'windows',
        remoteHost,
        hostShell: 'powershell.exe',
        globalShell: 'cmd.exe',
        tabShell: 'cmd.exe',
        sessionShell: 'cmd.exe'
      })
    ).toBe('powershell')
  })

  it('falls back to PowerShell when the remote host has not published its shell', () => {
    expect(
      resolve({
        targetShell: 'windows',
        remoteHost: { runtimeEnvironmentId: 'env-1' },
        globalShell: 'cmd.exe'
      })
    ).toBe('powershell')
    expect(
      resolve({
        targetShell: 'windows',
        remoteHost: { runtimeEnvironmentId: 'env-1' },
        hostShell: null
      })
    ).toBe('powershell')
    expect(
      resolve({
        targetShell: 'windows',
        remoteHost: { runtimeEnvironmentId: null },
        hostShell: 'cmd.exe'
      })
    ).toBe('powershell')
  })
})
