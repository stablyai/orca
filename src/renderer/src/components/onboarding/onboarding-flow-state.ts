import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../../shared/constants'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { STEPS } from './use-onboarding-flow-types'

type TaskSourcesSnapshotProps = EventProps<'onboarding_task_sources_snapshot'>
type TaskSourcesGithubStatus = TaskSourcesSnapshotProps['github_status']
type TaskSourcesLinearStatus = TaskSourcesSnapshotProps['linear_status']
export type TaskSourcesExitAction = TaskSourcesSnapshotProps['exit_action']

export function shouldSkipIntegrationsStep(status: AppState['preflightStatus']): boolean {
  return status?.gh.installed === true
}

export function shouldSkipWindowsTerminalStep(isWindows: boolean): boolean {
  return !isWindows
}

export type OnboardingStepSkipOptions = {
  skipIntegrations: boolean
  skipWindowsTerminal: boolean
}

export function isSkippedStepIndex(index: number, options: OnboardingStepSkipOptions): boolean {
  const step = STEPS[index]
  return (
    (options.skipIntegrations && step?.id === 'integrations') ||
    (options.skipWindowsTerminal && step?.id === 'windows_terminal')
  )
}

export function resolveStepIndex(
  index: number,
  skipOptions: OnboardingStepSkipOptions,
  direction: 'forward' | 'backward'
): number {
  const lastIndex = STEPS.length - 1
  let nextIndex = Math.min(Math.max(index, 0), lastIndex)
  while (isSkippedStepIndex(nextIndex, skipOptions)) {
    const candidate = nextIndex + (direction === 'forward' ? 1 : -1)
    if (candidate < 0 || candidate > lastIndex) {
      return direction === 'forward' ? lastIndex : 0
    }
    nextIndex = candidate
  }
  return nextIndex
}

export function getGitHubTaskSourceStatus(
  status: AppState['preflightStatus'],
  loading: boolean
): TaskSourcesGithubStatus {
  if (loading || !status) {
    return 'checking'
  }
  if (!status.gh.installed) {
    return 'not_installed'
  }
  return status.gh.authenticated ? 'connected' : 'not_authenticated'
}

export function getLinearTaskSourceStatus(
  status: AppState['linearStatus'],
  checked: boolean
): TaskSourcesLinearStatus {
  if (status.connected) {
    return 'connected'
  }
  return checked ? 'not_connected' : 'checking'
}

type OnboardingStepId = (typeof STEPS)[number]['id']

type OnboardingProgressSnapshot = Pick<
  OnboardingState,
  'flowVersion' | 'lastCompletedStep' | 'outcome'
>

export function remapOpenOnboardingLastCompletedStep({
  flowVersion,
  lastCompletedStep,
  outcome
}: OnboardingProgressSnapshot): number {
  if (flowVersion === ONBOARDING_FLOW_VERSION) {
    return lastCompletedStep
  }
  if (outcome === 'completed' && lastCompletedStep >= 4) {
    return ONBOARDING_FINAL_STEP
  }
  // Why: in v3 (four-step, pre-Windows-terminal) step 4 already meant notifications, so resume there.
  if (flowVersion === 3) {
    return Math.min(4, lastCompletedStep)
  }
  // Why: v2 (five-step) and older seven-step data used step 4 for removed agent setup, not integrations.
  if (flowVersion === 2) {
    if (lastCompletedStep === 3) {
      return 2
    }
    if (lastCompletedStep >= 4) {
      return 3
    }
    return lastCompletedStep
  }
  if (lastCompletedStep === 3) {
    return 2
  }
  if (lastCompletedStep === 4) {
    return 2
  }
  if (lastCompletedStep >= 5) {
    return 3
  }
  return lastCompletedStep
}

type SkippedOnboardingPreferenceOptions = {
  currentStepId: OnboardingStepId
  themeBeforePreview: GlobalSettings['theme'] | null
  settingsTheme: GlobalSettings['theme'] | undefined
  selectedAgent: TuiAgent | null
  setTheme: (theme: GlobalSettings['theme']) => void
  applyTheme: (theme: GlobalSettings['theme']) => void
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  setError: (message: string | null) => void
}

export async function prepareSkippedOnboardingPreferences({
  currentStepId,
  themeBeforePreview,
  settingsTheme,
  selectedAgent,
  setTheme,
  applyTheme,
  updateSettings,
  setError
}: SkippedOnboardingPreferenceOptions): Promise<boolean> {
  try {
    // Why: theme tiles save immediately for a stable preview, but skip must not keep this step's choice.
    if (currentStepId === 'theme') {
      const themeToRestore = themeBeforePreview ?? settingsTheme
      if (themeToRestore) {
        setTheme(themeToRestore)
        applyTheme(themeToRestore)
        await updateSettings({ theme: themeToRestore })
      }
    }
    // Why: skipping bypasses step persistence, so save the visible agent choice before closing.
    if (currentStepId === 'agent' && selectedAgent) {
      await updateSettings({ defaultTuiAgent: selectedAgent })
    }
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setError(message)
    toast.error(
      translate(
        'auto.components.onboarding.use.onboarding.flow.52acfbef51',
        'Could not save progress'
      ),
      { description: message }
    )
    return false
  }
}
