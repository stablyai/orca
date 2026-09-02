import { useCallback, useEffect, useRef, useState } from 'react'
import { applyDocumentTheme } from '@/lib/document-theme'
import { track } from '@/lib/telemetry'
import { ONBOARDING_FINAL_STEP } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { AppState } from '@/store/types'
import {
  getGitHubTaskSourceStatus,
  getLinearTaskSourceStatus,
  type TaskSourcesExitAction
} from './onboarding-flow-state'
import type { StepNumber, STEPS } from './use-onboarding-flow-types'
type OnboardingTelemetryArgs = {
  remappedLastCompletedStep: number
  currentStep: (typeof STEPS)[number]
  persistedThemeRef: { current: GlobalSettings['theme'] }
  preflightStatus: AppState['preflightStatus']
  preflightStatusLoading: boolean
  linearStatus: AppState['linearStatus']
  linearStatusChecked: boolean
}

export function useOnboardingFlowTelemetry({
  remappedLastCompletedStep,
  currentStep,
  persistedThemeRef,
  preflightStatus,
  preflightStatusLoading,
  linearStatus,
  linearStatusChecked
}: OnboardingTelemetryArgs) {
  const startedTrackedRef = useRef(false)
  useEffect(() => {
    if (startedTrackedRef.current) {
      return
    }
    startedTrackedRef.current = true
    const lastCompleted = remappedLastCompletedStep
    track(
      'onboarding_started',
      lastCompleted >= 1 && lastCompleted < ONBOARDING_FINAL_STEP
        ? { resumed_from_step: lastCompleted as StepNumber }
        : {}
    )
  }, [remappedLastCompletedStep])

  const [initialStepStartedAt] = useState(() => Date.now())
  const stepStartedAtRef = useRef<number>(initialStepStartedAt)
  useEffect(() => {
    stepStartedAtRef.current = Date.now()
    track('onboarding_step_viewed', {
      step: currentStep.stepNumber,
      value_kind: currentStep.valueKind
    })
  }, [currentStep.id, currentStep.stepNumber, currentStep.valueKind])

  const consumeStepDurationMs = useCallback((): number => {
    return Math.max(0, Date.now() - stepStartedAtRef.current)
  }, [])

  const setLifecycleRootRef = useCallback(
    (node: HTMLElement | null): void => {
      if (node === null) {
        applyDocumentTheme(persistedThemeRef.current)
      }
    },
    [persistedThemeRef]
  )

  const trackTaskSourcesSnapshot = useCallback(
    (
      exitAction: TaskSourcesExitAction,
      durationMs: number,
      advancedVia: 'button' | 'keyboard'
    ): void => {
      const payload: EventProps<'onboarding_task_sources_snapshot'> = {
        github_status: getGitHubTaskSourceStatus(preflightStatus, preflightStatusLoading),
        linear_status: getLinearTaskSourceStatus(linearStatus, linearStatusChecked),
        exit_action: exitAction,
        duration_ms: durationMs,
        advanced_via: advancedVia
      }
      track('onboarding_task_sources_snapshot', payload)
    },
    [linearStatus, linearStatusChecked, preflightStatus, preflightStatusLoading]
  )

  return { consumeStepDurationMs, setLifecycleRootRef, trackTaskSourcesSnapshot }
}
