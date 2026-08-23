import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  getHostFallbackAgentSkillRuntime,
  getProjectAgentSkillRuntime,
  getProjectAgentSkillTerminalShellOverride,
  getProjectSkillDiscoveryTarget,
  getProjectSkillInstallDisabledReason
} from './project-skill-runtime'

const hostRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'project-1',
    reason: 'project-override',
    cacheKey: 'project-1:windows-host'
  }
}

const wslRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'project-1',
    distro: 'Ubuntu-24.04',
    reason: 'project-override',
    cacheKey: 'project-1:wsl:Ubuntu-24.04'
  }
}

const repairRuntime: ProjectExecutionRuntimeResolution = {
  status: 'repair-required',
  repair: {
    projectId: 'project-1',
    preferredRuntime: { kind: 'wsl', distro: 'Missing' },
    reason: 'wsl-distro-missing',
    source: 'project-override',
    cacheKey: 'project-1:repair:wsl-distro-missing:Missing'
  }
}

describe('project skill runtime helpers', () => {
  it('keeps a legacy WSL runtime on its intrinsic Windows parent host', () => {
    expect(
      getHostFallbackAgentSkillRuntime({ runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL' })
    ).toEqual({
      runtime: 'host',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'Windows'
    })
  })

  it('passes the resolved project runtime through the discovery target', () => {
    expect(getProjectSkillDiscoveryTarget(wslRuntime)).toEqual({ projectRuntime: wslRuntime })
    expect(getProjectSkillDiscoveryTarget(undefined)).toBeUndefined()
  })

  it('maps resolved host and WSL project runtimes into setup runtimes', () => {
    expect(getProjectAgentSkillRuntime(hostRuntime, 'win32')).toEqual({
      runtime: 'host',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'Windows'
    })
    expect(getProjectAgentSkillRuntime(wslRuntime, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu-24.04',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'WSL Ubuntu-24.04'
    })
  })

  it('keeps repair-required WSL projects scoped to their preferred distro', () => {
    expect(getProjectAgentSkillRuntime(repairRuntime, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Missing',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'WSL Missing'
    })
    expect(getProjectSkillInstallDisabledReason(repairRuntime)).toContain('unavailable')
  })

  it('forces PowerShell for WSL setup and for host setup when the terminal shell is WSL', () => {
    expect(
      getProjectAgentSkillTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'wsl.exe' },
        getProjectAgentSkillRuntime(hostRuntime, 'win32')
      )
    ).toBe('powershell.exe')
    expect(
      getProjectAgentSkillTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'pwsh.exe' },
        getProjectAgentSkillRuntime(wslRuntime, 'win32')
      )
    ).toBe('powershell.exe')
  })

  it('forces PowerShell for host setup when the terminal shell is Git Bash', () => {
    // Git Bash rewrites the leading /d /s /c arguments of the generated command as MSYS paths.
    expect(
      getProjectAgentSkillTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'git-bash' },
        getProjectAgentSkillRuntime(hostRuntime, 'win32')
      )
    ).toBe('powershell.exe')
    expect(
      getProjectAgentSkillTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'cmd.exe' },
        getProjectAgentSkillRuntime(hostRuntime, 'win32')
      )
    ).toBeUndefined()
  })

  it('uses execution-host shell metadata before viewer settings', () => {
    expect(
      getProjectAgentSkillTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'powershell.exe' },
        {
          runtime: 'host',
          hostPlatform: 'win32',
          terminalWindowsShell: 'git-bash',
          label: 'Windows'
        }
      )
    ).toBe('powershell.exe')
    for (const terminalWindowsShell of ['powershell.exe', undefined]) {
      expect(
        getProjectAgentSkillTerminalShellOverride(
          'win32',
          { terminalWindowsShell: 'git-bash' },
          { runtime: 'host', hostPlatform: 'win32', terminalWindowsShell, label: 'Windows' }
        )
      ).toBeUndefined()
    }
  })
})
