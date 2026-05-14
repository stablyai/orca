import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../../shared/computer-use-permissions-types'
import {
  COMPUTER_USE_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  type AgentFeatureSkillId,
  type AgentFeatureSkillInstallSummary
} from '@/lib/agent-feature-install-commands'
import {
  BROWSER_USE_ENABLED_STORAGE_KEY,
  BROWSER_USE_SKILL_INSTALLED_STORAGE_KEY
} from '@/lib/browser-use-setup-state'
import { e2eConfig } from '@/lib/e2e-config'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SKILL_INSTALLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'

export type OnboardingFeatureSetupId = 'browserUse' | 'computerUse' | 'orchestration'

export type OnboardingFeatureSetupSelection = Record<OnboardingFeatureSetupId, boolean>

export const DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION: OnboardingFeatureSetupSelection = {
  browserUse: true,
  computerUse: true,
  orchestration: true
}

export const ONBOARDING_FEATURE_SETUP_IDS: readonly OnboardingFeatureSetupId[] = [
  'browserUse',
  'computerUse',
  'orchestration'
]

const FEATURE_SKILL_COMMANDS: Record<OnboardingFeatureSetupId, { label: string; command: string }> =
  {
    browserUse: {
      label: 'Agent Browser Use',
      command: ORCA_CLI_SKILL_INSTALL_COMMAND
    },
    computerUse: {
      label: 'Computer Use',
      command: COMPUTER_USE_SKILL_INSTALL_COMMAND
    },
    orchestration: {
      label: 'Agent Orchestration',
      command: ORCHESTRATION_SKILL_INSTALL_COMMAND
    }
  }

const FEATURE_SKILL_IDS: Record<OnboardingFeatureSetupId, AgentFeatureSkillId> = {
  browserUse: 'orca-cli',
  computerUse: 'computer-use',
  orchestration: 'orchestration'
}

export type OnboardingFeatureSetupWarning = {
  featureId: OnboardingFeatureSetupId | 'cli' | 'skills'
  message: string
}

export type OnboardingFeatureSetupResult = {
  selectedIds: OnboardingFeatureSetupId[]
  cliTouched: boolean
  skillsInstalled: boolean
  skillCommandsCopied: boolean
  computerUsePermissionsOpened: boolean
  warnings: OnboardingFeatureSetupWarning[]
}

export type OnboardingFeatureSetupDeps = {
  getCliStatus: () => Promise<CliInstallStatus>
  installCli: () => Promise<CliInstallStatus>
  installSkills: (skillIds: AgentFeatureSkillId[]) => Promise<AgentFeatureSkillInstallSummary>
  writeClipboardText: (text: string) => Promise<void>
  getComputerUsePermissionStatus: () => Promise<ComputerUsePermissionStatusResult>
  openComputerUsePermissionSetup: () => Promise<ComputerUsePermissionSetupResult>
  setStorageItem: (key: string, value: string) => void
  removeStorageItem: (key: string) => void
  notifyOrchestrationStateChanged: () => void
}

export function hasSelectedOnboardingFeatureSetup(
  selection: OnboardingFeatureSetupSelection
): boolean {
  return ONBOARDING_FEATURE_SETUP_IDS.some((id) => selection[id])
}

export function selectedOnboardingFeatureSetupIds(
  selection: OnboardingFeatureSetupSelection
): OnboardingFeatureSetupId[] {
  return ONBOARDING_FEATURE_SETUP_IDS.filter((id) => selection[id])
}

export function buildOnboardingFeatureSetupClipboardText(
  selection: OnboardingFeatureSetupSelection
): string | null {
  const commands = selectedOnboardingFeatureSetupIds(selection).map(
    (id) => FEATURE_SKILL_COMMANDS[id]
  )
  if (commands.length === 0) {
    return null
  }
  return commands.map(({ label, command }) => `# ${label}\n${command}`).join('\n\n')
}

export function createOnboardingFeatureSetupDeps(): OnboardingFeatureSetupDeps {
  const e2eDeps = getE2EOnboardingFeatureSetupDeps()
  if (e2eDeps) {
    return e2eDeps
  }

  return {
    getCliStatus: () => window.api.cli.getInstallStatus(),
    installCli: () => window.api.cli.install(),
    installSkills: (skillIds) => window.api.agentFeatureSkills.install({ skillIds }),
    writeClipboardText: (text) => window.api.ui.writeClipboardText(text),
    getComputerUsePermissionStatus: () => window.api.computerUsePermissions.getStatus(),
    openComputerUsePermissionSetup: () => window.api.computerUsePermissions.openSetup(),
    setStorageItem: (key, value) => localStorage.setItem(key, value),
    removeStorageItem: (key) => localStorage.removeItem(key),
    notifyOrchestrationStateChanged: notifyOrchestrationSetupStateChanged
  }
}

function getE2EOnboardingFeatureSetupDeps(): OnboardingFeatureSetupDeps | null {
  if (!e2eConfig.enabled || typeof window === 'undefined') {
    return null
  }
  return (
    (window as unknown as { __onboardingFeatureSetupDeps?: OnboardingFeatureSetupDeps })
      .__onboardingFeatureSetupDeps ?? null
  )
}

export async function runOnboardingFeatureSetup(
  selection: OnboardingFeatureSetupSelection,
  deps: OnboardingFeatureSetupDeps = createOnboardingFeatureSetupDeps()
): Promise<OnboardingFeatureSetupResult> {
  const selectedIds = selectedOnboardingFeatureSetupIds(selection)
  const warnings: OnboardingFeatureSetupWarning[] = []
  let cliTouched = false
  let skillsInstalled = false
  let skillCommandsCopied = false
  let computerUsePermissionsOpened = false

  if (selectedIds.length === 0) {
    return {
      selectedIds,
      cliTouched,
      skillsInstalled,
      skillCommandsCopied,
      computerUsePermissionsOpened,
      warnings
    }
  }

  try {
    const status = await deps.getCliStatus()
    if (!status.supported) {
      warnings.push({
        featureId: 'cli',
        message: status.detail ?? 'Orca CLI registration is not available on this platform.'
      })
    } else if (status.state !== 'installed') {
      const next = await deps.installCli()
      cliTouched = true
      if (next.state !== 'installed') {
        warnings.push({
          featureId: 'cli',
          message: next.detail ?? 'Orca CLI registration needs attention.'
        })
      } else if (!next.pathConfigured && next.detail) {
        warnings.push({ featureId: 'cli', message: next.detail })
      }
    } else if (!status.pathConfigured && status.detail) {
      warnings.push({ featureId: 'cli', message: status.detail })
    }
  } catch (error) {
    warnings.push({ featureId: 'cli', message: formatFeatureSetupError(error) })
  }

  if (selection.browserUse) {
    deps.setStorageItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  }

  if (selection.computerUse) {
    try {
      const status = await deps.getComputerUsePermissionStatus()
      const needsMacPermissions =
        status.platform === 'darwin' &&
        status.permissions.some((permission) => permission.status !== 'granted')
      if (needsMacPermissions) {
        await deps.openComputerUsePermissionSetup()
        computerUsePermissionsOpened = true
      }
    } catch (error) {
      warnings.push({
        featureId: 'computerUse',
        message: formatFeatureSetupError(error)
      })
    }
  }

  if (selection.orchestration) {
    deps.setStorageItem(ORCHESTRATION_ENABLED_STORAGE_KEY, '1')
    deps.removeStorageItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY)
    deps.notifyOrchestrationStateChanged()
  }

  try {
    const skillIds = selectedIds.map((id) => FEATURE_SKILL_IDS[id])
    const skillResult = await deps.installSkills(skillIds)
    const failedSkillResults = skillResult.results.filter((result) => !result.ok)
    markInstalledSkills(skillResult, deps)
    skillsInstalled = skillResult.results.length > 0 && failedSkillResults.length === 0
    for (const result of failedSkillResults) {
      warnings.push({
        featureId: featureIdForSkillId(result.skillId),
        message: result.detail ?? 'Skill install failed.'
      })
    }
    if (failedSkillResults.length > 0) {
      skillCommandsCopied = await copySkillCommandsFallback(selection, deps, warnings)
    }
  } catch (error) {
    warnings.push({ featureId: 'skills', message: formatFeatureSetupError(error) })
    skillCommandsCopied = await copySkillCommandsFallback(selection, deps, warnings)
  }

  return {
    selectedIds,
    cliTouched,
    skillsInstalled,
    skillCommandsCopied,
    computerUsePermissionsOpened,
    warnings
  }
}

function formatFeatureSetupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markInstalledSkills(
  summary: AgentFeatureSkillInstallSummary,
  deps: OnboardingFeatureSetupDeps
): void {
  for (const result of summary.results) {
    if (!result.ok) {
      continue
    }
    if (result.skillId === 'orca-cli') {
      deps.setStorageItem(BROWSER_USE_SKILL_INSTALLED_STORAGE_KEY, '1')
    }
    if (result.skillId === 'orchestration') {
      deps.setStorageItem(ORCHESTRATION_SKILL_INSTALLED_STORAGE_KEY, '1')
    }
  }
}

function featureIdForSkillId(
  skillId: AgentFeatureSkillId
): OnboardingFeatureSetupWarning['featureId'] {
  switch (skillId) {
    case 'orca-cli':
      return 'browserUse'
    case 'computer-use':
      return 'computerUse'
    case 'orchestration':
      return 'orchestration'
  }
}

async function copySkillCommandsFallback(
  selection: OnboardingFeatureSetupSelection,
  deps: OnboardingFeatureSetupDeps,
  warnings: OnboardingFeatureSetupWarning[]
): Promise<boolean> {
  const clipboardText = buildOnboardingFeatureSetupClipboardText(selection)
  if (!clipboardText) {
    return false
  }
  try {
    await deps.writeClipboardText(clipboardText)
    return true
  } catch (error) {
    warnings.push({ featureId: 'skills', message: formatFeatureSetupError(error) })
    return false
  }
}
