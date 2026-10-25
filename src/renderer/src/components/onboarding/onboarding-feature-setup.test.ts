import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../../shared/computer-use-permissions-types'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCA_LINEAR_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-skill-names'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY
} from '@/lib/orchestration-setup-state'
import {
  DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION,
  onboardingFeatureSetupSkillNames,
  onboardingFeatureSetupTelemetryFeature,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupDeps,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'

const ALL_SKILL_NAMES = [
  ORCA_CLI_SKILL_NAME,
  COMPUTER_USE_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME,
  ORCA_LINEAR_SKILL_NAME
]

const GRANTED_COMPUTER_USE_STATUS: ComputerUsePermissionStatusResult = {
  platform: 'darwin',
  helperAppPath: '/Applications/Orca Computer Use.app',
  helperUnavailableReason: null,
  permissions: [
    { id: 'accessibility', status: 'granted' },
    { id: 'screenshots', status: 'granted' }
  ]
}

const OPENED_COMPUTER_USE_SETUP: ComputerUsePermissionSetupResult = {
  platform: 'darwin',
  helperAppPath: '/Applications/Orca.app',
  openedSettings: true,
  launchedHelper: true
}

function createDeps(
  overrides: Partial<OnboardingFeatureSetupDeps> = {}
): OnboardingFeatureSetupDeps & {
  storage: Map<string, string>
} {
  const storage = new Map<string, string>()
  return {
    storage,
    getComputerUsePermissionStatus: vi.fn(async () => GRANTED_COMPUTER_USE_STATUS),
    openComputerUsePermissionSetup: vi.fn(async () => OPENED_COMPUTER_USE_SETUP),
    setStorageItem: vi.fn((key: string, value: string) => {
      storage.set(key, value)
    }),
    removeStorageItem: vi.fn((key: string) => {
      storage.delete(key)
    }),
    notifyOrchestrationStateChanged: vi.fn(),
    ...overrides
  }
}

describe('onboarding feature setup runner', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults every setup item on so first-launch setup is ready to run', () => {
    expect(DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION).toEqual({
      browserUse: true,
      computerUse: true,
      orchestration: true,
      linearTickets: false
    })
  })

  it('lists the skills for the selected onboarding feature setup items', () => {
    expect(
      onboardingFeatureSetupSkillNames({
        browserUse: true,
        computerUse: true,
        orchestration: true,
        linearTickets: true
      })
    ).toEqual(ALL_SKILL_NAMES)
    expect(
      onboardingFeatureSetupSkillNames({
        browserUse: false,
        computerUse: false,
        orchestration: true,
        linearTickets: false
      })
    ).toEqual([ORCHESTRATION_SKILL_NAME])
  })

  it('maps feature setup items to privacy-safe telemetry ids', () => {
    expect(onboardingFeatureSetupTelemetryFeature('browserUse')).toBe('browser_use')
  })

  it('runs selected feature setup through injected deps only', async () => {
    const deps = createDeps({
      getComputerUsePermissionStatus: vi.fn(
        async (): Promise<ComputerUsePermissionStatusResult> => ({
          platform: 'darwin',
          helperAppPath: '/Applications/Orca Computer Use.app',
          helperUnavailableReason: null,
          permissions: [
            { id: 'accessibility', status: 'not-granted' },
            { id: 'screenshots', status: 'granted' }
          ]
        })
      )
    })

    const result = await runOnboardingFeatureSetup(
      { browserUse: true, computerUse: true, orchestration: true, linearTickets: true },
      deps
    )

    expect(result).toEqual({
      selectedIds: ['browserUse', 'computerUse', 'orchestration', 'linearTickets'],
      skillNames: ALL_SKILL_NAMES,
      computerUsePermissionsOpened: true,
      warnings: []
    })
    expect(deps.getComputerUsePermissionStatus).toHaveBeenCalledTimes(1)
    expect(deps.openComputerUsePermissionSetup).toHaveBeenCalledTimes(1)
    expect(deps.storage.get(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe('1')
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('1')
    expect(deps.removeStorageItem).toHaveBeenCalledWith(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY)
    expect(deps.notifyOrchestrationStateChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps invasive Browser Use and Computer Use setup untouched when only Orchestration is selected', async () => {
    const deps = createDeps()
    const selection: OnboardingFeatureSetupSelection = {
      browserUse: false,
      computerUse: false,
      orchestration: true,
      linearTickets: false
    }

    const result = await runOnboardingFeatureSetup(selection, deps)

    expect(result.selectedIds).toEqual(['orchestration'])
    expect(result.skillNames).toEqual([ORCHESTRATION_SKILL_NAME])
    expect(result.computerUsePermissionsOpened).toBe(false)
    expect(deps.getComputerUsePermissionStatus).not.toHaveBeenCalled()
    expect(deps.openComputerUsePermissionSetup).not.toHaveBeenCalled()
    expect(deps.storage.get(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe('0')
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('1')
  })

  it('clears feature markers when no setup items are selected', async () => {
    const deps = createDeps()

    const result = await runOnboardingFeatureSetup(
      { browserUse: false, computerUse: false, orchestration: false, linearTickets: false },
      deps
    )

    expect(result).toEqual({
      selectedIds: [],
      skillNames: [],
      computerUsePermissionsOpened: false,
      warnings: []
    })
    expect(deps.storage.get(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe('0')
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('0')
    expect(deps.getComputerUsePermissionStatus).not.toHaveBeenCalled()
  })

  it('keeps main’s skill selection but skips permissions when the Computer Use helper is unavailable', async () => {
    // Missing helpers report every permission ungranted; do not call openSetup, which would throw.
    const unavailableStatus: ComputerUsePermissionStatusResult = {
      platform: 'darwin',
      helperAppPath: null,
      helperUnavailableReason: 'Orca Computer Use.app was not found',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    }
    const openComputerUsePermissionSetup = vi.fn(async () => OPENED_COMPUTER_USE_SETUP)
    const deps = createDeps({
      getComputerUsePermissionStatus: vi.fn(async () => unavailableStatus),
      openComputerUsePermissionSetup
    })

    const result = await runOnboardingFeatureSetup(
      { browserUse: true, computerUse: true, orchestration: true, linearTickets: true },
      deps
    )

    expect(result.skillNames).toEqual(['orca-cli', 'computer-use', 'orchestration', 'orca-linear'])
    expect(result.computerUsePermissionsOpened).toBe(false)
    expect(openComputerUsePermissionSetup).not.toHaveBeenCalled()
    expect(result.warnings).toContainEqual({
      featureId: 'computerUse',
      message: 'Orca Computer Use.app was not found'
    })
  })
})
