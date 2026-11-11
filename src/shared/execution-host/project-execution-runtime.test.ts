import { describe, expect, it } from 'vitest'
import { deriveGlobalWindowsRuntimeDefaultFromLegacySettings } from './project-runtime-legacy-migration'
import { resolveProjectExecutionRuntime } from './project-execution-runtime'

describe('deriveGlobalWindowsRuntimeDefaultFromLegacySettings', () => {
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

  it('carries Windows Git into the resolved WSL runtime and its cache key', () => {
    expect(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: 'project-1',
        projectRuntimePreference: { kind: 'wsl', distro: 'Debian', git: 'windows-host' },
        globalWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'project-1',
        distro: 'Debian',
        reason: 'project-override',
        git: 'windows-host',
        cacheKey: 'project-1:wsl:Debian:git-windows-host'
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
