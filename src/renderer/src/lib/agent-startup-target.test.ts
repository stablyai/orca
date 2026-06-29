import { describe, expect, it, vi } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

vi.mock('./new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))

const windowsHostProjectRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'project-1',
    reason: 'project-override',
    cacheKey: 'project-1:windows-host:project-override'
  }
}

const wslProjectRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    distro: 'Ubuntu',
    projectId: 'project-1',
    reason: 'project-override',
    cacheKey: 'project-1:wsl:Ubuntu'
  }
}

describe('resolveAgentStartupTarget', () => {
  it('uses target defaults for runtime-owned Windows paths', async () => {
    const { resolveAgentStartupTarget } = await import('./agent-startup-target')

    expect(
      resolveAgentStartupTarget({
        host: {
          executionHostId: 'runtime:env-1',
          path: String.raw`C:\Users\alice\repo`
        },
        terminalWindowsShell: 'git-bash'
      })
    ).toEqual({ platform: 'win32', shell: 'powershell' })
  })

  it('uses project runtime to distinguish local Windows host from WSL', async () => {
    const { resolveAgentStartupTarget } = await import('./agent-startup-target')

    expect(
      resolveAgentStartupTarget({
        host: { executionHostId: 'local', path: String.raw`C:\Users\alice\repo` },
        projectRuntime: windowsHostProjectRuntime,
        terminalWindowsShell: 'wsl.exe'
      })
    ).toEqual({ platform: 'win32', shell: 'powershell' })
    expect(
      resolveAgentStartupTarget({
        host: { executionHostId: 'local', path: String.raw`C:\Users\alice\repo` },
        projectRuntime: wslProjectRuntime,
        terminalWindowsShell: 'powershell.exe'
      })
    ).toEqual({ platform: 'linux', shell: 'posix' })
  })
})
