import type {
  PreflightStatus,
  PreloadApi,
  RefreshAgentsResult
} from '../../../../preload/api-types'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../../shared/computer-use-permissions-types'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import type { SkillDiscoveryResult } from '../../../../shared/skills'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { getBrowserPlatform } from './web-storage'

export function createPreflightApi(): NonNullable<Partial<PreloadApi>['preflight']> {
  const fallbackStatus: PreflightStatus = {
    git: { installed: false },
    gh: { installed: false, authenticated: false },
    glab: { installed: false, authenticated: false },
    bitbucket: { configured: false, authenticated: false, account: null },
    azureDevOps: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    },
    gitea: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  const fallbackRefreshAgents: RefreshAgentsResult = {
    agents: [],
    addedPathSegments: [],
    shellHydrationOk: false,
    pathSource: 'sync_seed_only',
    pathFailureReason: 'spawn_error'
  }
  type WindowsTerminalCapabilityBridgeResult = {
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }
  const fallbackWindowsTerminalCapabilities = {
    wslAvailable: false,
    wslDistros: [],
    pwshAvailable: false,
    gitBashAvailable: false,
    hostPlatform: null
  }
  return {
    check: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return fallbackStatus
      }
      return callRuntimeResult<PreflightStatus>('preflight.check', args)
    },
    detectAgents: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      return callRuntimeResult<string[]>('preflight.detectAgents').catch(() => [])
    },
    refreshAgents: () =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult('preflight.refreshAgents')
            .then((result) => result as RefreshAgentsResult)
            .catch(() => fallbackRefreshAgents)
        : Promise.resolve(fallbackRefreshAgents),
    detectRemoteAgents: async (args) =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult<string[]>('preflight.detectRemoteAgents', args).catch(() => [])
        : [],
    detectRemoteWindowsTerminalCapabilities: async (args) =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult<WindowsTerminalCapabilityBridgeResult>(
            'preflight.detectRemoteWindowsTerminalCapabilities',
            args
          ).catch(() => fallbackWindowsTerminalCapabilities)
        : Promise.resolve(fallbackWindowsTerminalCapabilities)
  }
}

export function createDeveloperPermissionsApi(): NonNullable<
  Partial<PreloadApi>['developerPermissions']
> {
  return {
    getStatus: () => Promise.resolve([]),
    request: ({ id }) =>
      Promise.resolve({ id, status: 'unsupported', openedSystemSettings: false } as const),
    openSettings: () => Promise.resolve(),
    testLocalNetworkConnection: ({ host, port }) =>
      Promise.resolve({
        ok: false,
        host,
        port,
        testedAt: Date.now(),
        failure: 'unsupported'
      } as const)
  }
}

export function createComputerUsePermissionsApi(): NonNullable<
  Partial<PreloadApi>['computerUsePermissions']
> {
  return {
    getStatus: () =>
      callRuntimeResult<ComputerUsePermissionStatusResult>(
        'computer.permissionsStatus',
        {},
        15_000
      ),
    openSetup: (args) =>
      callRuntimeResult<ComputerUsePermissionSetupResult>(
        'computer.permissions',
        args ?? {},
        15_000
      ).catch(() => ({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        openedSettings: false,
        launchedHelper: false,
        nextStep: 'Computer-use permissions are managed on the Orca server.'
      })),
    reset: () =>
      Promise.resolve({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        helperUnavailableReason: 'web_client',
        bundleId: null,
        permissions: []
      })
  }
}

export function createSkillsApi(): NonNullable<Partial<PreloadApi>['skills']> {
  return {
    discover: (target) =>
      callRuntimeResult<SkillDiscoveryResult>('skills.discover', target, 15_000),
    // Why: browser clients have no local skill homes; remote-host freshness stays off until its update rail covers it.
    freshnessInventory: (): Promise<SkillFreshnessInventory> =>
      Promise.resolve({
        schemaVersion: 1,
        installations: [],
        eligibleUpdateNames: [],
        scanIssues: [],
        scannedAt: Date.now()
      }),
    // Why: with no local skill homes there is nothing to update, so the run rail
    // reports a permanently idle state rather than spawning anything.
    startUpdateRun: () => Promise.resolve({ started: false as const, reason: 'invalid-names' }),
    cancelUpdateRun: () => Promise.resolve(),
    acknowledgeUpdateRun: () => Promise.resolve(),
    getUpdateRun: () => Promise.resolve({ state: 'idle' as const }),
    prepareShare: () => Promise.reject(new Error('Skill publishing requires the desktop app.')),
    publishShare: () => Promise.reject(new Error('Skill publishing requires the desktop app.')),
    cancelShare: () => Promise.resolve(),
    releaseShare: () => Promise.resolve(),
    resolveShare: () => Promise.reject(new Error('Skill share links require the desktop app.')),
    installShare: () => Promise.reject(new Error('Skill installation requires the desktop app.')),
    installBundleShare: () =>
      Promise.reject(new Error('Skill installation requires the desktop app.')),
    installPackageVersion: () =>
      Promise.reject(new Error('Skill installation requires the desktop app.')),
    installBundlePackageVersion: () =>
      Promise.reject(new Error('Skill installation requires the desktop app.')),
    cancelInstall: () => Promise.resolve({ cancelled: false }),
    previewInstall: () => Promise.reject(new Error('Skill installation requires the desktop app.')),
    previewBundleInstall: () =>
      Promise.reject(new Error('Skill installation requires the desktop app.')),
    removeInstall: () => Promise.reject(new Error('Skill installation requires the desktop app.')),
    listManagedInstalls: () =>
      Promise.reject(new Error('Skill installation requires the desktop app.')),
    getPackage: () => Promise.reject(new Error('Skill installation requires the desktop app.')),
    listOwnedShares: () =>
      Promise.reject(new Error('Skill package management requires the desktop app.')),
    revokeShare: () =>
      Promise.reject(new Error('Skill package management requires the desktop app.')),
    deletePackageVersion: () =>
      Promise.reject(new Error('Skill package management requires the desktop app.')),
    deletePackage: () =>
      Promise.reject(new Error('Skill package management requires the desktop app.')),
    listWslDistros: () => Promise.resolve([]),
    onInstallProgress: () => () => {},
    onShareProgress: () => () => {},
    onUpdateRun: () => () => {}
  }
}
