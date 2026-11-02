import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeLaunchTargetArgs } from './agent-resume-launch-target'

function setNavigatorUserAgent(userAgent: string): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      platform: userAgent.includes('Windows') ? 'Win32' : 'MacIntel',
      userAgent
    }
  })
  return () => {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original)
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator
    }
  }
}

const LOCAL_WINDOWS_ARGS: AgentResumeLaunchTargetArgs = {
  projectRuntime: undefined,
  connectionId: null,
  executionHostId: 'local',
  worktreePath: 'C:\\Users\\neil\\orca\\workspaces\\orca\\feature',
  terminalWindowsShell: null
}

async function resolveWith(
  overrides: Partial<AgentResumeLaunchTargetArgs>
): Promise<{ platform: NodeJS.Platform; shell: string | undefined }> {
  const { resolveAgentResumeLaunchTarget } = await import('./agent-resume-launch-target')
  const { platform, shell } = resolveAgentResumeLaunchTarget({
    ...LOCAL_WINDOWS_ARGS,
    ...overrides
  })
  return { platform, shell }
}

describe('resolveAgentResumeLaunchTarget on a Windows client', () => {
  let restoreNavigator = (): void => {}

  beforeAll(() => {
    vi.resetModules()
  })

  beforeEach(() => {
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  it('quotes for cmd.exe when the global Windows shell is cmd.exe', async () => {
    await expect(resolveWith({ terminalWindowsShell: 'cmd.exe' })).resolves.toEqual({
      platform: 'win32',
      shell: 'cmd'
    })
  })

  it('prefers the per-tab shell override over the global Windows shell', async () => {
    await expect(
      resolveWith({
        terminalWindowsShell: 'powershell.exe',
        tabShellOverride: 'C:\\WINDOWS\\system32\\cmd.exe'
      })
    ).resolves.toEqual({ platform: 'win32', shell: 'cmd' })
  })

  it('quotes for POSIX on a Git Bash tab', async () => {
    await expect(resolveWith({ terminalWindowsShell: 'git-bash' })).resolves.toEqual({
      platform: 'win32',
      shell: 'posix'
    })
  })

  it('keeps PowerShell quoting when no Windows shell is configured', async () => {
    await expect(resolveWith({})).resolves.toEqual({
      platform: 'win32',
      shell: 'powershell'
    })
  })

  it('leaves an SSH workspace on its own default quoting', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })

  it('quotes for PowerShell on an SSH host that reported Windows', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1',
        remotePlatform: 'win32',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'win32', shell: undefined })
  })

  it('quotes for cmd.exe on a Windows SSH host tab whose shell is cmd.exe', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1',
        remotePlatform: 'win32',
        tabShellOverride: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'win32', shell: 'cmd' })
  })

  it('keeps POSIX quoting for a WSL UNC workspace on a Windows SSH host', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1',
        remotePlatform: 'win32',
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\repo'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })

  it('quotes for the platform a remote runtime host reported', async () => {
    await expect(
      resolveWith({
        executionHostId: 'runtime:prod-box',
        remotePlatform: 'linux',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })

  // Why: Codex's paste-burst flag must follow the server's OS, not this client's quoting (#34496).
  it.each([
    ['linux', 'linux'],
    ['win32', 'win32'],
    [null, null]
  ] as const)('reports a paired server on %s as the agent host OS', async (reported, expected) => {
    const { resolveAgentResumeLaunchTarget } = await import('./agent-resume-launch-target')
    const target = resolveAgentResumeLaunchTarget({
      ...LOCAL_WINDOWS_ARGS,
      executionHostId: 'runtime:prod-box',
      worktreePath: '/srv/repo',
      runtimeHostPlatform: reported
    })
    expect(target.agentHostPlatform).toBe(expected)
  })

  it('leaves an SSH host that has not reported its OS unknown', async () => {
    const { resolveAgentResumeLaunchTarget } = await import('./agent-resume-launch-target')
    const target = resolveAgentResumeLaunchTarget({
      ...LOCAL_WINDOWS_ARGS,
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      worktreePath: '/home/neil/repo'
    })
    expect(target.agentHostPlatform).toBeNull()
  })

  // Why: an older server omits its OS, but its drive-letter workspace path still proves Windows.
  it('keeps Windows quoting for an older Windows server that does not report its OS', async () => {
    await expect(
      resolveWith({ executionHostId: 'runtime:prod-box', worktreePath: 'C:\\srv\\repo' })
    ).resolves.toEqual({ platform: 'win32', shell: undefined })
  })

  it('does not describe a remote runtime host with the local Windows shell setting', async () => {
    await expect(
      resolveWith({
        executionHostId: 'runtime:prod-box',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'win32', shell: undefined })
  })

  // Why POSIX: a server that reports no OS and no Windows path gets the quoting a fresh launch would use.
  it('quotes POSIX for a server that reports no OS for a POSIX path', async () => {
    await expect(
      resolveWith({ executionHostId: 'runtime:prod-box', worktreePath: '/srv/repo' })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })

  it('keeps POSIX quoting for a WSL UNC worktree', async () => {
    await expect(
      resolveWith({
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\repo',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })

  it('keeps POSIX quoting for a project pinned to a WSL runtime', async () => {
    await expect(
      resolveWith({
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            distro: 'Ubuntu',
            projectId: 'repo-1',
            reason: 'project-override',
            cacheKey: 'repo-1:wsl:Ubuntu'
          }
        } as AgentResumeLaunchTargetArgs['projectRuntime'],
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })
})

describe('resolveAgentResumeLaunchTarget off Windows', () => {
  let restoreNavigator = (): void => {}

  beforeEach(() => {
    vi.resetModules()
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  it('quotes for cmd.exe on a Windows SSH host from a mac client', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1',
        worktreePath: 'C:\\Users\\neil\\repo',
        remotePlatform: 'win32',
        tabShellOverride: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'win32', shell: 'cmd' })
  })

  // Why: a paired server's resume quotes for the OS it reported, as its fresh launches do.
  it.each([
    [{}, { platform: 'win32', shell: undefined }],
    // The server's own terminal shell decides quoting; its panes never receive a tab's override.
    [{ runtimeHostTerminalWindowsShell: 'cmd.exe' }, { platform: 'win32', shell: 'cmd' }],
    [{ runtimeHostTerminalWindowsShell: 'git-bash' }, { platform: 'win32', shell: 'posix' }],
    [{ tabShellOverride: 'cmd.exe' }, { platform: 'win32', shell: undefined }],
    [
      { runtimeHostTerminalWindowsShell: 'cmd.exe', tabShellOverride: 'powershell.exe' },
      { platform: 'win32', shell: 'cmd' }
    ]
  ] as const)(
    'quotes for a Windows paired server from a mac client (%o)',
    async (tab, expected) => {
      await expect(
        resolveWith({
          executionHostId: 'runtime:prod-box',
          worktreePath: 'C:\\srv\\repo',
          runtimeHostPlatform: 'win32',
          ...tab
        })
      ).resolves.toEqual(expected)
    }
  )

  it('quotes a nested SSH target on a Windows paired server for that target, not the server', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-nested',
        executionHostId: 'runtime:prod-box',
        worktreePath: '/home/neil/repo',
        runtimeHostPlatform: 'win32'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })

  it('ignores a stale Windows shell setting on a mac client', async () => {
    await expect(
      resolveWith({
        worktreePath: '/Users/neil/repo',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'darwin', shell: undefined })
  })
})

// Why: a paired server's nested SSH target runs the command, so its own reported OS decides quoting.
describe('resolveSshHostReportedPlatform for a nested SSH target', () => {
  it('reads the target the server reaches, not the server', async () => {
    const { resolveSshHostReportedPlatform } = await import('./agent-resume-launch-target')
    const state = {
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map([
        [
          'prod-box',
          {
            connectionStates: new Map([
              [
                'ssh-nested',
                {
                  targetId: 'ssh-nested',
                  status: 'connected' as const,
                  error: null,
                  reconnectAttempt: 0,
                  remotePlatform: 'win32' as const
                }
              ]
            ]),
            targetLabels: new Map(),
            targetGenerations: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    }
    expect(resolveSshHostReportedPlatform(state, 'runtime:prod-box', null, 'ssh-nested')).toBe(
      'win32'
    )
    expect(resolveSshHostReportedPlatform(state, 'runtime:prod-box', null, null)).toBeNull()
  })
})
