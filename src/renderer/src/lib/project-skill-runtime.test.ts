import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
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
  it('passes the resolved project runtime through the discovery target', () => {
    expect(getProjectSkillDiscoveryTarget(wslRuntime)).toEqual({ projectRuntime: wslRuntime })
    expect(getProjectSkillDiscoveryTarget(undefined)).toBeUndefined()
  })

  it('maps resolved host and WSL project runtimes into setup runtimes', () => {
    expect(getProjectAgentSkillRuntime(hostRuntime, 'win32')).toEqual({
      runtime: 'host',
      label: 'Windows'
    })
    expect(getProjectAgentSkillRuntime(wslRuntime, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu-24.04',
      label: 'WSL Ubuntu-24.04'
    })
  })

  it('keeps repair-required WSL projects scoped to their preferred distro', () => {
    expect(getProjectAgentSkillRuntime(repairRuntime, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Missing',
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
})
