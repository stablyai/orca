import { describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../../shared/computer-use-permissions-types'
import {
  buildAgentFeatureSkillInstallCommand,
  COMPUTER_USE_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY
} from '@/lib/orchestration-setup-state'
import {
  DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION,
  buildOnboardingFeatureSetupClipboardText,
  onboardingFeatureSetupRunTelemetry,
  onboardingFeatureSetupTelemetryFeature,
  onboardingFeatureSetupTelemetrySelection,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupDeps,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'

const ALL_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCA_CLI_SKILL_NAME,
  COMPUTER_USE_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
])
const ORCHESTRATION_ONLY_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCHESTRATION_SKILL_NAME
])

const INSTALLED_CLI_STATUS: CliInstallStatus = {
  platform: 'darwin',
  commandName: 'orca',
  commandPath: '/usr/local/bin/orca',
  pathDirectory: '/usr/local/bin',
  pathConfigured: true,
  launcherPath: '/Applications/Orca.app/Contents/MacOS/Orca',
  installMethod: 'symlink',
  supported: true,
  state: 'installed',
  currentTarget: '/Applications/Orca.app/Contents/MacOS/Orca',
  unsupportedReason: null,
  detail: null
}

const GRANTED_COMPUTER_USE_STATUS: ComputerUsePermissionStatusResult = {
  platform: 'darwin',
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
  clipboardWrites: string[]
} {
  const storage = new Map<string, string>()
  const clipboardWrites: string[] = []
  return {
    storage,
    clipboardWrites,
    getCliStatus: vi.fn(async () => INSTALLED_CLI_STATUS),
    installCli: vi.fn(async () => INSTALLED_CLI_STATUS),
    writeClipboardText: vi.fn(async (text: string) => {
      clipboardWrites.push(text)
    }),
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
  it('defaults every setup item on so first-launch setup is ready to run', () => {
    expect(DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION).toEqual({
      browserUse: true,
      computerUse: true,
      orchestration: true
    })
  })

  it('builds one skill command for the selected Browser Use, Computer Use, and Orchestration features', () => {
    const text = buildOnboardingFeatureSetupClipboardText({
      browserUse: true,
      computerUse: true,
      orchestration: true
    })

    expect(text).toBe(ALL_SKILL_INSTALL_COMMAND)
    expect(text).toBe(
      'npx skills add https://github.com/stablyai/orca --skill orca-cli computer-use orchestration --global'
    )
  })

  it('builds privacy-safe telemetry payloads for selected feature setup items', () => {
    const selection: OnboardingFeatureSetupSelection = {
      browserUse: true,
      computerUse: false,
      orchestration: true
    }

    expect(onboardingFeatureSetupTelemetryFeature('browserUse')).toBe('browser_use')
    expect(onboardingFeatureSetupTelemetrySelection(selection)).toEqual({
      browser_use: true,
      computer_use: false,
      orchestration: true,
      selected_count: 2
    })
    expect(
      onboardingFeatureSetupRunTelemetry(selection, {
        selectedIds: ['browserUse', 'orchestration'],
        cliTouched: true,
        skillCommandsCopied: false,
        skillInstallCommand: ORCHESTRATION_ONLY_SKILL_INSTALL_COMMAND,
        computerUsePermissionsOpened: false,
        warnings: [{ featureId: 'skills', message: 'Clipboard unavailable' }]
      })
    ).toEqual({
      browser_use: true,
      computer_use: false,
      orchestration: true,
      selected_count: 2,
      cli_touched: true,
      skill_commands_copied: false,
      skill_install_command_prepared: true,
      computer_use_permissions_opened: false,
      warning_count: 1
    })
  })

  it('runs selected Browser Use, Computer Use, and Orchestration setup through injected deps only', async () => {
    const deps = createDeps({
      getComputerUsePermissionStatus: vi.fn(
        async (): Promise<ComputerUsePermissionStatusResult> => ({
          platform: 'darwin',
          permissions: [
            { id: 'accessibility', status: 'not-granted' },
            { id: 'screenshots', status: 'granted' }
          ]
        })
      )
    })

    const result = await runOnboardingFeatureSetup(
      { browserUse: true, computerUse: true, orchestration: true },
      deps
    )

    expect(result).toEqual({
      selectedIds: ['browserUse', 'computerUse', 'orchestration'],
      cliTouched: false,
      skillCommandsCopied: true,
      skillInstallCommand: ALL_SKILL_INSTALL_COMMAND,
      computerUsePermissionsOpened: true,
      warnings: []
    })
    expect(deps.getCliStatus).toHaveBeenCalledTimes(1)
    expect(deps.installCli).not.toHaveBeenCalled()
    expect(deps.getComputerUsePermissionStatus).toHaveBeenCalledTimes(1)
    expect(deps.openComputerUsePermissionSetup).toHaveBeenCalledTimes(1)
    expect(deps.storage.get(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe('1')
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('1')
    expect(deps.removeStorageItem).toHaveBeenCalledWith(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY)
    expect(deps.notifyOrchestrationStateChanged).toHaveBeenCalledTimes(1)
    expect(deps.clipboardWrites).toEqual([ALL_SKILL_INSTALL_COMMAND])
  })

  it('keeps invasive Browser Use and Computer Use setup untouched when only Orchestration is selected', async () => {
    const deps = createDeps()
    const selection: OnboardingFeatureSetupSelection = {
      browserUse: false,
      computerUse: false,
      orchestration: true
    }

    const result = await runOnboardingFeatureSetup(selection, deps)

    expect(result.selectedIds).toEqual(['orchestration'])
    expect(result.skillCommandsCopied).toBe(true)
    expect(result.skillInstallCommand).toBe(ORCHESTRATION_ONLY_SKILL_INSTALL_COMMAND)
    expect(result.computerUsePermissionsOpened).toBe(false)
    expect(deps.getCliStatus).toHaveBeenCalledTimes(1)
    expect(deps.installCli).not.toHaveBeenCalled()
    expect(deps.getComputerUsePermissionStatus).not.toHaveBeenCalled()
    expect(deps.openComputerUsePermissionSetup).not.toHaveBeenCalled()
    expect(deps.storage.get(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe('0')
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('1')
    expect(deps.clipboardWrites).toEqual([ORCHESTRATION_ONLY_SKILL_INSTALL_COMMAND])
  })

  it('clears feature markers when no setup items are selected', async () => {
    const deps = createDeps()

    const result = await runOnboardingFeatureSetup(
      { browserUse: false, computerUse: false, orchestration: false },
      deps
    )

    expect(result).toEqual({
      selectedIds: [],
      cliTouched: false,
      skillCommandsCopied: false,
      skillInstallCommand: null,
      computerUsePermissionsOpened: false,
      warnings: []
    })
    expect(deps.storage.get(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe('0')
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('0')
    expect(deps.getCliStatus).not.toHaveBeenCalled()
    expect(deps.getComputerUsePermissionStatus).not.toHaveBeenCalled()
    expect(deps.clipboardWrites).toEqual([])
  })

  it('warns when selected skill commands cannot be copied', async () => {
    const deps = createDeps({
      writeClipboardText: vi.fn(async () => {
        throw new Error('Clipboard unavailable')
      })
    })

    const result = await runOnboardingFeatureSetup(
      { browserUse: false, computerUse: false, orchestration: true },
      deps
    )

    expect(result.skillCommandsCopied).toBe(false)
    expect(result.skillInstallCommand).toBe(ORCHESTRATION_ONLY_SKILL_INSTALL_COMMAND)
    expect(result.warnings).toEqual([
      {
        featureId: 'skills',
        message: 'Clipboard unavailable'
      }
    ])
    expect(deps.clipboardWrites).toEqual([])
  })
})
