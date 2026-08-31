import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

describe('web preload API composition', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('../../../shared/e2e-config')
  })

  it('installs the exact concrete surface without enumerating fallback namespaces', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    expect(Object.keys(globals.window.api)).toEqual([
      'app',
      'starNag',
      'platform',
      'workspacePorts',
      'orcaProfiles',
      'e2e',
      'settings',
      'agentAwake',
      'keybindings',
      'ui',
      'crashReports',
      'diagnostics',
      'session',
      'onboarding',
      'cache',
      'runtime',
      'nativeChat',
      'runtimeEnvironments',
      'repos',
      'worktrees',
      'fs',
      'git',
      'browser',
      'emulator',
      'gh',
      'gl',
      'hostedReview',
      'linear',
      'hooks',
      'stats',
      'memory',
      'aiVault',
      'preflight',
      'notifications',
      'rateLimits',
      'minimaxCredentials',
      'grokAccounts',
      'codexAccounts',
      'claudeAccounts',
      'cli',
      'agentHooks',
      'macosTccPrompts',
      'codexConfigSync',
      'developerPermissions',
      'computerUsePermissions',
      'updater',
      'shell',
      'skills',
      'pty',
      'ssh',
      'wsl',
      'pwsh',
      'gitBash',
      'agentStatus',
      'mobile',
      'telemetryTrack',
      'telemetrySetOptIn',
      'telemetryGetConsentState',
      'telemetryAcknowledgeBanner'
    ])
    expect(Object.keys(globals.window.api.projects)).toEqual([])
    expect(Reflect.get(globals.window.api.projects, 'then')).toBeUndefined()
    expect(Object.keys(globals.window.electron)).toEqual([])
  })

  it('snapshots E2E config before runtime storage initialization', async () => {
    const evaluationOrder: string[] = []
    const createE2EConfig = vi.fn((config: unknown) => {
      evaluationOrder.push('e2e')
      return config
    })
    vi.doMock('../../../shared/e2e-config', () => ({ createE2EConfig }))
    vi.stubEnv('VITE_EXPOSE_STORE', 'true')
    const globals = installBrowserGlobals('Linux')
    Object.assign(globals.window.location, {
      search: '?orcaE2ETerminalParkingDelayMs=23&orcaE2ETerminalRetentionLimit=7'
    })
    const readStored = globals.storage.getItem.bind(globals.storage)
    vi.spyOn(globals.storage, 'getItem').mockImplementation((key) => {
      evaluationOrder.push(`storage:${key}`)
      return readStored(key)
    })

    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    expect(evaluationOrder[0]).toBe('e2e')
    expect(createE2EConfig).toHaveBeenCalledWith({
      exposeStore: true,
      terminalParkingDelayMs: 23,
      terminalRetentionLimit: 7
    })
    expect(globals.window.api.e2e.getConfig()).toEqual({
      exposeStore: true,
      terminalParkingDelayMs: 23,
      terminalRetentionLimit: 7
    })
  })
})
