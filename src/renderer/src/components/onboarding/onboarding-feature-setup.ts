import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../../shared/computer-use-permissions-types'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCA_LINEAR_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-skill-names'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import { e2eConfig } from '@/lib/e2e-config'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { BundledSkillInstallState } from '@/hooks/use-bundled-skill-install'

export type OnboardingFeatureSetupId =
  | 'browserUse'
  | 'computerUse'
  | 'orchestration'
  | 'linearTickets'

export type OnboardingFeatureSetupSelection = Record<OnboardingFeatureSetupId, boolean>

export const DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION: OnboardingFeatureSetupSelection = {
  browserUse: true,
  computerUse: true,
  orchestration: true,
  linearTickets: false
}

export const ONBOARDING_FEATURE_SETUP_IDS: readonly OnboardingFeatureSetupId[] = [
  'browserUse',
  'computerUse',
  'orchestration',
  'linearTickets'
]

const FEATURE_SKILL_NAMES: Record<OnboardingFeatureSetupId, string> = {
  browserUse: ORCA_CLI_SKILL_NAME,
  computerUse: COMPUTER_USE_SKILL_NAME,
  orchestration: ORCHESTRATION_SKILL_NAME,
  linearTickets: ORCA_LINEAR_SKILL_NAME
}

const FEATURE_TELEMETRY_IDS: Record<
  OnboardingFeatureSetupId,
  EventProps<'onboarding_feature_setup_toggled'>['feature']
> = {
  browserUse: 'browser_use',
  computerUse: 'computer_use',
  orchestration: 'orchestration',
  linearTickets: 'linear_tickets'
}

export type OnboardingFeatureSetupWarning = {
  featureId: OnboardingFeatureSetupId | 'skills'
  message: string
}

export type OnboardingFeatureSetupResult = {
  selectedIds: OnboardingFeatureSetupId[]
  // The caller installs these with the bundled installer.
  skillNames: string[]
  computerUsePermissionsOpened: boolean
  warnings: OnboardingFeatureSetupWarning[]
}

export type OnboardingFeatureSetupDeps = {
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

export function onboardingFeatureSetupSkillNames(
  selection: OnboardingFeatureSetupSelection
): string[] {
  return selectedOnboardingFeatureSetupIds(selection).map((id) => FEATURE_SKILL_NAMES[id])
}

export function onboardingFeatureSetupTelemetryFeature(
  id: OnboardingFeatureSetupId
): EventProps<'onboarding_feature_setup_toggled'>['feature'] {
  return FEATURE_TELEMETRY_IDS[id]
}

// Why: Linear ticket setup is a recommended add-on, not onboarding progress.
const ONBOARDING_PROGRESS_FEATURE_SETUP_IDS: readonly OnboardingFeatureSetupId[] = [
  'browserUse',
  'computerUse',
  'orchestration'
]

export function onboardingFeatureSetupTelemetrySelection(
  selection: OnboardingFeatureSetupSelection
): EventProps<'onboarding_feature_setup_terminal_opened'> {
  return {
    browser_use: selection.browserUse,
    computer_use: selection.computerUse,
    linear_tickets: selection.linearTickets,
    orchestration: selection.orchestration,
    selected_count: ONBOARDING_PROGRESS_FEATURE_SETUP_IDS.filter((id) => selection[id]).length
  }
}

const SKILL_INSTALL_TELEMETRY_RESULT: Record<
  BundledSkillInstallState['kind'],
  EventProps<'onboarding_feature_setup_run'>['skill_install_result'] | null
> = {
  idle: null,
  installing: null,
  done: 'installed',
  unsupported: 'update_server',
  failed: 'failed'
}

/** Null until the install settles; nothing identifying leaves the machine. */
export function onboardingFeatureSetupRunTelemetry(
  selection: OnboardingFeatureSetupSelection,
  result: OnboardingFeatureSetupResult,
  install: BundledSkillInstallState
): EventProps<'onboarding_feature_setup_run'> | null {
  const installResult =
    install.kind === 'done' && !install.summary.ok
      ? 'needs_attention'
      : install.kind === 'unsupported' && install.reason === 'connect-host'
        ? 'connect_host'
        : SKILL_INSTALL_TELEMETRY_RESULT[install.kind]
  if (!installResult) {
    return null
  }
  return {
    ...onboardingFeatureSetupTelemetrySelection(selection),
    cli_touched: false,
    skill_install_result: installResult,
    computer_use_permissions_opened: result.computerUsePermissionsOpened,
    warning_count: result.warnings.length
  }
}

export function createOnboardingFeatureSetupDeps(): OnboardingFeatureSetupDeps {
  const e2eDeps = getE2EOnboardingFeatureSetupDeps()
  if (e2eDeps) {
    return e2eDeps
  }

  return {
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
  explicitDeps?: OnboardingFeatureSetupDeps
): Promise<OnboardingFeatureSetupResult> {
  const deps = explicitDeps ?? createOnboardingFeatureSetupDeps()
  const selectedIds = selectedOnboardingFeatureSetupIds(selection)
  const warnings: OnboardingFeatureSetupWarning[] = []
  const skillNames = onboardingFeatureSetupSkillNames(selection)
  let computerUsePermissionsOpened = false

  deps.setStorageItem(BROWSER_USE_ENABLED_STORAGE_KEY, selection.browserUse ? '1' : '0')
  deps.setStorageItem(ORCHESTRATION_ENABLED_STORAGE_KEY, selection.orchestration ? '1' : '0')
  if (selection.orchestration) {
    deps.removeStorageItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY)
  }
  deps.notifyOrchestrationStateChanged()

  if (selectedIds.length === 0) {
    return { selectedIds, skillNames, computerUsePermissionsOpened, warnings }
  }

  if (selection.computerUse) {
    try {
      const status = await deps.getComputerUsePermissionStatus()
      // Why: when the macOS helper app is missing (e.g. dev builds without
      // `pnpm build:computer-macos`), the status reports all permissions as
      // not-granted alongside a helperUnavailableReason. Without this guard we
      // would call openSetup, which throws an IPC handler error instead of
      // degrading gracefully.
      if (status.helperUnavailableReason) {
        warnings.push({
          featureId: 'computerUse',
          message: status.helperUnavailableReason
        })
      } else {
        const needsMacPermissions =
          status.platform === 'darwin' &&
          status.permissions.some((permission) => permission.status !== 'granted')
        if (needsMacPermissions) {
          await deps.openComputerUsePermissionSetup()
          computerUsePermissionsOpened = true
        }
      }
    } catch (error) {
      warnings.push({
        featureId: 'computerUse',
        message: formatFeatureSetupError(error)
      })
    }
  }

  return { selectedIds, skillNames, computerUsePermissionsOpened, warnings }
}

function formatFeatureSetupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
