import { describe, expect, it } from 'vitest'
import { resolveStartupShellForLaunchHost } from './agent-startup-shell'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

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

describe('resolveStartupShellForLaunchHost', () => {
  it('uses the configured Windows shell only for local launch hosts', () => {
    expect(resolveStartupShellForLaunchHost('win32', null, 'git-bash')).toBe('posix')
    expect(
      resolveStartupShellForLaunchHost(
        'win32',
        { connectionId: null, executionHostId: 'local' },
        'cmd.exe'
      )
    ).toBe('cmd')
  })

  it('uses target defaults for SSH and runtime launch hosts', () => {
    expect(
      resolveStartupShellForLaunchHost(
        'win32',
        { connectionId: 'builder', executionHostId: null },
        'git-bash'
      )
    ).toBe('powershell')
    expect(
      resolveStartupShellForLaunchHost(
        'win32',
        { connectionId: null, executionHostId: 'runtime:host-1' },
        'git-bash'
      )
    ).toBe('powershell')
  })

  it('uses the actual Windows project host shell when WSL is only the global default', () => {
    expect(
      resolveStartupShellForLaunchHost(
        'win32',
        { connectionId: null, executionHostId: 'local' },
        'wsl.exe',
        windowsHostProjectRuntime
      )
    ).toBe('powershell')
  })
})
