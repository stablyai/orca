import { describe, expect, it } from 'vitest'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  normalizeProjectRuntimePreference,
  resolveProjectExecutionRuntime
} from './project-execution-runtime'

describe('normalizeProjectRuntimePreference', () => {
  it('preserves valid project runtime preferences', () => {
    expect(normalizeProjectRuntimePreference({ kind: 'inherit-global' })).toEqual({
      kind: 'inherit-global'
    })
    expect(normalizeProjectRuntimePreference({ kind: 'windows-host' })).toEqual({
      kind: 'windows-host'
    })
    expect(normalizeProjectRuntimePreference({ kind: 'wsl', distro: 'Ubuntu-24.04' })).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-24.04'
    })
  })

  it('falls back malformed project runtime preferences to inherit-global', () => {
    expect(normalizeProjectRuntimePreference(null)).toEqual({ kind: 'inherit-global' })
    expect(normalizeProjectRuntimePreference({ kind: 'wsl', distro: '   ' })).toEqual({
      kind: 'inherit-global'
    })
    expect(normalizeProjectRuntimePreference({ kind: 'bogus', distro: 'Ubuntu' })).toEqual({
      kind: 'inherit-global'
    })
  })
})

describe('deriveGlobalWindowsRuntimeDefaultFromLegacySettings', () => {
  it('defaults malformed legacy settings to the host global default', () => {
    expect(deriveGlobalWindowsRuntimeDefaultFromLegacySettings(null)).toEqual({
      defaultRuntime: { kind: 'windows-host' },
      fallbackReason: null
    })
  })

  it('migrates existing host settings to the host global default', () => {
    expect(
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings({
        localAgentRuntime: 'host',
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
    ).toEqual({
      defaultRuntime: { kind: 'windows-host' },
      fallbackReason: null
    })
  })

  it('migrates existing WSL agent settings with their selected distro', () => {
    expect(
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings({
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu-24.04',
        terminalWindowsWslDistro: 'Debian'
      })
    ).toEqual({
      defaultRuntime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      fallbackReason: null
    })
  })

  it('uses the terminal WSL distro when the agent setting only selected WSL', () => {
    expect(
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings({
        localAgentRuntime: 'wsl',
        terminalWindowsWslDistro: 'Debian'
      })
    ).toEqual({
      defaultRuntime: { kind: 'wsl', distro: 'Debian' },
      fallbackReason: null
    })
  })

  it('turns stale legacy WSL state into a migration host fallback when WSL is unavailable', () => {
    expect(
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
        { localAgentRuntime: 'wsl', localAgentWslDistro: 'Ubuntu' },
        { wslAvailable: false, availableWslDistros: [] }
      )
    ).toEqual({
      defaultRuntime: { kind: 'windows-host' },
      fallbackReason: 'legacy-wsl-unavailable'
    })
  })

  it('turns stale legacy WSL distro state into a migration host fallback', () => {
    expect(
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
        { localAgentRuntime: 'wsl', localAgentWslDistro: 'Ubuntu' },
        { wslAvailable: true, availableWslDistros: ['Debian'] }
      )
    ).toEqual({
      defaultRuntime: { kind: 'windows-host' },
      fallbackReason: 'legacy-wsl-distro-missing'
    })
  })
})

describe('resolveProjectExecutionRuntime', () => {
  it('ignores local Windows WSL preferences on non-Windows platforms', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'darwin',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu']
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'local-host',
        hostPlatform: 'darwin',
        projectId: 'project-1',
        reason: 'non-windows',
        cacheKey: 'project-1:local-host:darwin'
      }
    })
  })

  it('resolves inherited Windows projects to the host global default', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: { kind: 'windows-host' },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu']
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'project-1',
        reason: 'global-default',
        cacheKey: 'project-1:windows-host'
      }
    })
  })

  it('falls back malformed global defaults to Windows host', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: { kind: 'bogus', distro: 'Ubuntu' },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu']
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'project-1',
        reason: 'global-default',
        cacheKey: 'project-1:windows-host'
      }
    })
  })

  it('resolves inherited Windows projects to the WSL global default', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu', 'Debian']
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'project-1',
        distro: 'Ubuntu',
        reason: 'global-default',
        cacheKey: 'project-1:wsl:Ubuntu'
      }
    })
  })

  it('lets a project force host when the global default is WSL', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'windows-host' },
        globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu']
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'project-1',
        reason: 'project-override',
        cacheKey: 'project-1:windows-host'
      }
    })
  })

  it('lets a project force WSL when the global default is host', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'wsl', distro: 'Debian' },
        globalWindowsRuntimeDefault: { kind: 'windows-host' },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu', 'Debian']
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'project-1',
        distro: 'Debian',
        reason: 'project-override',
        cacheKey: 'project-1:wsl:Debian'
      }
    })
  })

  it('returns repair state instead of silently falling back when WSL is unavailable', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        globalWindowsRuntimeDefault: { kind: 'windows-host' },
        wslAvailable: false,
        availableWslDistros: []
      })
    ).toEqual({
      status: 'repair-required',
      repair: {
        projectId: 'project-1',
        preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
        reason: 'wsl-unavailable',
        source: 'project-override',
        cacheKey: 'project-1:repair:wsl-unavailable:Ubuntu'
      }
    })
  })

  it('returns repair state when WSL is selected without a distro', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: { kind: 'wsl', distro: null },
        wslAvailable: true,
        availableWslDistros: ['Ubuntu']
      })
    ).toEqual({
      status: 'repair-required',
      repair: {
        projectId: 'project-1',
        preferredRuntime: { kind: 'wsl', distro: null },
        reason: 'wsl-distro-required',
        source: 'global-default',
        cacheKey: 'project-1:repair:wsl-distro-required:default'
      }
    })
  })

  it('keeps two projects with different runtime preferences isolated', () => {
    const hostProject = resolveProjectExecutionRuntime({
      appPlatform: 'win32',
      projectId: 'host-project',
      projectRuntimePreference: { kind: 'windows-host' },
      globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
      wslAvailable: true,
      availableWslDistros: ['Ubuntu']
    })
    const wslProject = resolveProjectExecutionRuntime({
      appPlatform: 'win32',
      projectId: 'wsl-project',
      projectRuntimePreference: { kind: 'inherit-global' },
      globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
      wslAvailable: true,
      availableWslDistros: ['Ubuntu']
    })

    expect(hostProject).toMatchObject({
      status: 'resolved',
      runtime: { kind: 'windows-host', cacheKey: 'host-project:windows-host' }
    })
    expect(wslProject).toMatchObject({
      status: 'resolved',
      runtime: { kind: 'wsl', distro: 'Ubuntu', cacheKey: 'wsl-project:wsl:Ubuntu' }
    })
  })

  it('returns repair state when the selected distro is missing', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        globalWindowsRuntimeDefault: { kind: 'windows-host' },
        wslAvailable: true,
        availableWslDistros: ['Debian']
      })
    ).toEqual({
      status: 'repair-required',
      repair: {
        projectId: 'project-1',
        preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
        reason: 'wsl-distro-missing',
        source: 'project-override',
        cacheKey: 'project-1:repair:wsl-distro-missing:Ubuntu'
      }
    })
  })
})
