import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  return resolveAgentResumeLaunchTarget({
    ...LOCAL_WINDOWS_ARGS,
    ...overrides
  })
}

describe('resolveAgentResumeLaunchTarget on a Windows client', () => {
  let restoreNavigator = (): void => {}

  beforeEach(() => {
    vi.resetModules()
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

  it('does not describe a remote runtime host with the local Windows shell setting', async () => {
    await expect(
      resolveWith({
        executionHostId: 'runtime:prod-box',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'win32', shell: undefined })
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

  it('ignores a stale Windows shell setting on a mac client', async () => {
    await expect(
      resolveWith({
        worktreePath: '/Users/neil/repo',
        terminalWindowsShell: 'cmd.exe'
      })
    ).resolves.toEqual({ platform: 'darwin', shell: undefined })
  })
})
