import { describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../../shared/computer-use-permissions-types'
import {
  COMPUTER_USE_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_INSTALL_COMMAND
} from '@/lib/agent-feature-install-commands'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY
} from '@/lib/orchestration-setup-state'
import {
  DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION,
  buildOnboardingFeatureSetupClipboardText,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupDeps,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'

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

  it('builds skill commands for the selected Browser Use, Computer Use, and Orchestration features', () => {
    const text = buildOnboardingFeatureSetupClipboardText({
      browserUse: true,
      computerUse: true,
      orchestration: true
    })

    expect(text).toContain(ORCA_CLI_SKILL_INSTALL_COMMAND)
    expect(text).toContain(COMPUTER_USE_SKILL_INSTALL_COMMAND)
    expect(text).toContain(ORCHESTRATION_SKILL_INSTALL_COMMAND)
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
    expect(deps.clipboardWrites).toEqual([
      [
        `# Agent Browser Use\n${ORCA_CLI_SKILL_INSTALL_COMMAND}`,
        `# Computer Use\n${COMPUTER_USE_SKILL_INSTALL_COMMAND}`,
        `# Agent Orchestration\n${ORCHESTRATION_SKILL_INSTALL_COMMAND}`
      ].join('\n\n')
    ])
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
    expect(result.computerUsePermissionsOpened).toBe(false)
    expect(deps.getCliStatus).toHaveBeenCalledTimes(1)
    expect(deps.installCli).not.toHaveBeenCalled()
    expect(deps.getComputerUsePermissionStatus).not.toHaveBeenCalled()
    expect(deps.openComputerUsePermissionSetup).not.toHaveBeenCalled()
    expect(deps.storage.has(BROWSER_USE_ENABLED_STORAGE_KEY)).toBe(false)
    expect(deps.storage.get(ORCHESTRATION_ENABLED_STORAGE_KEY)).toBe('1')
    expect(deps.clipboardWrites).toEqual([
      `# Agent Orchestration\n${ORCHESTRATION_SKILL_INSTALL_COMMAND}`
    ])
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
    expect(result.warnings).toEqual([
      {
        featureId: 'skills',
        message: 'Clipboard unavailable'
      }
    ])
    expect(deps.clipboardWrites).toEqual([])
  })
})
