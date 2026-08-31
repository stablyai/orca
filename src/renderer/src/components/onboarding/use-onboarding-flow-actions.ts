import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { applyDocumentTheme } from '@/lib/document-theme'
import { track } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import { ONBOARDING_FINAL_STEP } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildWindowsTerminalSnapshotPayload } from './windows-terminal-onboarding-telemetry'
import { persistStep, type PersistCurrentStepResult } from './use-onboarding-flow-persistence'
import { STEPS, type StepNumber } from './use-onboarding-flow-types'
import {
  prepareSkippedOnboardingPreferences,
  resolveStepIndex,
  type OnboardingStepSkipOptions,
  type TaskSourcesExitAction
} from './onboarding-flow-state'

type CloseWith = (
  outcome: 'completed' | 'dismissed',
  lastStepReached: StepNumber,
  completedPath?: 'add_project_modal',
  dismissedExtras?: { advancedVia: 'button' | 'keyboard'; durationMs: number }
) => Promise<boolean>

type OnboardingFlowActionsArgs = {
  busyLabel: string | null
  setBusyLabel: Dispatch<SetStateAction<string | null>>
  setError: Dispatch<SetStateAction<string | null>>
  currentStep: (typeof STEPS)[number]
  consumeStepDurationMs: () => number
  trackTaskSourcesSnapshot: (
    exitAction: TaskSourcesExitAction,
    durationMs: number,
    advancedVia: 'button' | 'keyboard'
  ) => void
  settings: GlobalSettings | null
  persistCurrentStep: () => Promise<PersistCurrentStepResult>
  closeWith: CloseWith
  openModal: (modal: 'add-repo') => void
  getNextStepIndex: (index: number) => number
  onOnboardingChange: (state: OnboardingState) => void
  stepIndex: number
  setStepIndex: Dispatch<SetStateAction<number>>
  selectedAgent: TuiAgent | null
  themeStepEntryThemeRef: { current: GlobalSettings['theme'] | null }
  setTheme: Dispatch<SetStateAction<GlobalSettings['theme']>>
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  skipOptions: OnboardingStepSkipOptions
}

export function useOnboardingFlowActions({
  busyLabel,
  setBusyLabel,
  setError,
  currentStep,
  consumeStepDurationMs,
  trackTaskSourcesSnapshot,
  settings,
  persistCurrentStep,
  closeWith,
  openModal,
  getNextStepIndex,
  onOnboardingChange,
  stepIndex,
  setStepIndex,
  selectedAgent,
  themeStepEntryThemeRef,
  setTheme,
  updateSettings,
  skipOptions
}: OnboardingFlowActionsArgs) {
  // Why: sync latch; busyLabel state commits too late to stop a ~30ms Cmd+Enter auto-repeat from re-entering next() and skipping a step.
  const nextInFlightRef = useRef(false)
  const trackCurrentStepCompleted = useCallback(
    (advancedVia: 'button' | 'keyboard'): void => {
      const durationMs = consumeStepDurationMs()
      track('onboarding_step_completed', {
        step: currentStep.stepNumber,
        value_kind: currentStep.valueKind,
        duration_ms: durationMs,
        advanced_via: advancedVia
      })
      if (currentStep.id === 'integrations') {
        trackTaskSourcesSnapshot('continue', durationMs, advancedVia)
      }
      if (currentStep.id === 'windows_terminal') {
        track(
          'onboarding_windows_terminal_snapshot',
          buildWindowsTerminalSnapshotPayload({
            settings,
            exitAction: 'continue',
            durationMs,
            advancedVia
          })
        )
      }
    },
    [
      consumeStepDurationMs,
      currentStep.id,
      currentStep.stepNumber,
      currentStep.valueKind,
      settings,
      trackTaskSourcesSnapshot
    ]
  )
  const next = useCallback(
    async (advancedVia: 'button' | 'keyboard' = 'button') => {
      if (nextInFlightRef.current || busyLabel) {
        return
      }
      nextInFlightRef.current = true
      try {
        const result = await persistCurrentStep()
        if (result.ok) {
          trackCurrentStepCompleted(advancedVia)
          if (currentStep.id === 'notifications') {
            setBusyLabel('Opening Add Project...')
            const closed = await closeWith('completed', ONBOARDING_FINAL_STEP, 'add_project_modal')
            if (closed) {
              openModal('add-repo')
            }
            return
          }
          const nextIndex = getNextStepIndex(stepIndex)
          const skippedThroughStepNumber = STEPS[nextIndex].stepNumber - 1
          if (skippedThroughStepNumber > currentStep.stepNumber) {
            // Why: skipped optional pages must still persist progress at the next visible page.
            try {
              onOnboardingChange(await persistStep(skippedThroughStepNumber))
            } catch (err) {
              toast.error(
                translate(
                  'auto.components.onboarding.use.onboarding.flow.52acfbef51',
                  'Could not save progress'
                ),
                {
                  description: err instanceof Error ? err.message : String(err)
                }
              )
            }
          }
          setStepIndex(nextIndex)
        }
      } finally {
        setBusyLabel(null)
        nextInFlightRef.current = false
      }
    },
    [
      busyLabel,
      closeWith,
      currentStep.id,
      currentStep.stepNumber,
      getNextStepIndex,
      onOnboardingChange,
      openModal,
      persistCurrentStep,
      stepIndex,
      trackCurrentStepCompleted,
      setBusyLabel,
      setStepIndex
    ]
  )

  const skipToRepo = useCallback(async () => {
    if (busyLabel) {
      return
    }
    setError(null)
    if (currentStep.id === 'notifications') {
      return
    }
    const durationMs = consumeStepDurationMs()
    const preferencesSaved = await prepareSkippedOnboardingPreferences({
      currentStepId: currentStep.id,
      themeBeforePreview: themeStepEntryThemeRef.current,
      settingsTheme: settings?.theme,
      selectedAgent,
      setTheme,
      applyTheme: applyDocumentTheme,
      updateSettings,
      setError
    })
    if (!preferencesSaved) {
      return
    }
    const stepId = currentStep.id
    const stepNumber = currentStep.stepNumber
    const valueKind = currentStep.valueKind
    setBusyLabel('Opening Add Project...')
    try {
      const closed = await closeWith('completed', ONBOARDING_FINAL_STEP, 'add_project_modal')
      if (!closed) {
        return
      }
      // Why: repo picker now lives in the Add Project dialog, so skipping optional setup closes onboarding and hands off to it.
      track('onboarding_step_skipped', {
        step: stepNumber,
        value_kind: valueKind,
        duration_ms: durationMs,
        advanced_via: 'button'
      })
      if (stepId === 'integrations') {
        trackTaskSourcesSnapshot('skip_to_project_setup', durationMs, 'button')
      }
      if (stepId === 'windows_terminal') {
        track(
          'onboarding_windows_terminal_snapshot',
          buildWindowsTerminalSnapshotPayload({
            settings,
            exitAction: 'skip_to_project_setup',
            durationMs,
            advancedVia: 'button'
          })
        )
      }
      openModal('add-repo')
    } finally {
      setBusyLabel(null)
    }
  }, [
    busyLabel,
    closeWith,
    consumeStepDurationMs,
    currentStep.id,
    currentStep.stepNumber,
    currentStep.valueKind,
    openModal,
    selectedAgent,
    settings,
    trackTaskSourcesSnapshot,
    updateSettings,
    setBusyLabel,
    setError,
    setTheme,
    themeStepEntryThemeRef
  ])

  const dismissOnboarding = useCallback(
    async (advancedVia: 'button' | 'keyboard' = 'button'): Promise<boolean> => {
      if (busyLabel) {
        return false
      }
      setError(null)
      return closeWith('dismissed', currentStep.stepNumber, undefined, {
        durationMs: consumeStepDurationMs(),
        advancedVia
      })
    },
    [busyLabel, closeWith, consumeStepDurationMs, currentStep.stepNumber, setError]
  )

  const back = useCallback(() => {
    setStepIndex((index) => resolveStepIndex(index - 1, skipOptions, 'backward'))
  }, [setStepIndex, skipOptions])

  const jumpToStep = useCallback(
    (idx: number) => {
      setStepIndex(resolveStepIndex(idx, skipOptions, idx < stepIndex ? 'backward' : 'forward'))
    },
    [setStepIndex, skipOptions, stepIndex]
  )

  return { next, skipToRepo, dismissOnboarding, back, jumpToStep }
}
