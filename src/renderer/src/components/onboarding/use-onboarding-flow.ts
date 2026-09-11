import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { applyDocumentTheme } from '@/lib/document-theme'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { STEPS } from './use-onboarding-flow-types'
import { persistStep, useCloseWith, usePersistCurrentStep } from './use-onboarding-flow-persistence'
import { useOnboardingSettingsDraft } from './use-onboarding-settings-draft'
import { translate } from '@/i18n/i18n'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
  isSkippedStepIndex,
  remapOpenOnboardingLastCompletedStep,
  resolveStepIndex,
  shouldSkipIntegrationsStep,
  shouldSkipWindowsTerminalStep
} from './onboarding-flow-state'

import { useOnboardingFlowActions } from './use-onboarding-flow-actions'
import { useOnboardingFlowTelemetry } from './use-onboarding-flow-telemetry'
export { STEPS } from './use-onboarding-flow-types'
export type { StepId, StepNumber } from './use-onboarding-flow-types'

export function useOnboardingFlow(
  onboarding: OnboardingState,
  onOnboardingChange: (state: OnboardingState) => void
) {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const isDetectingAgents = useAppStore((s) => s.isDetectingAgents || s.isRefreshingAgents)
  const openModal = useAppStore((s) => s.openModal)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  // Why: renderToStaticMarkup uses Zustand's initial snapshot; the sync read keeps tests and the first client render aligned.
  const effectivePreflightStatus = preflightStatus ?? useAppStore.getState().preflightStatus

  const skipIntegrations = shouldSkipIntegrationsStep(effectivePreflightStatus)
  const skipWindowsTerminal = shouldSkipWindowsTerminalStep(isWindowsUserAgent())
  const skipOptions = useMemo(
    () => ({ skipIntegrations, skipWindowsTerminal }),
    [skipIntegrations, skipWindowsTerminal]
  )
  const remappedLastCompletedStep = remapOpenOnboardingLastCompletedStep(onboarding)
  const initialStep = resolveStepIndex(
    Math.min(Math.max(remappedLastCompletedStep, 0), STEPS.length - 1),
    skipOptions,
    'forward'
  )
  const [stepIndex, setStepIndex] = useState(initialStep)
  const {
    selectedAgent,
    setSelectedAgent,
    yoloPermissions,
    setYoloPermissions,
    agentStatusHooksEnabled,
    setAgentStatusHooksEnabled,
    theme,
    setTheme,
    setThemeInteractive
  } = useOnboardingSettingsDraft()
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [, setError] = useState<string | null>(null)

  const detectedSet = useMemo(() => new Set(detectedAgentIds ?? []), [detectedAgentIds])
  const currentStep = STEPS[stepIndex]
  // Why: the stepper shows only steps the user will land on; skipped optional steps are dropped, not rendered as dead dots.
  const progressSteps = useMemo(
    () =>
      STEPS.map((step, index) => ({ step, index })).filter(
        ({ index }) => !isSkippedStepIndex(index, skipOptions)
      ),
    [skipOptions]
  )
  // Why: while resuming, stepIndex can briefly point at a just-skipped step; resolve forward so the count reflects the landing step.
  const displayedStepIndex = resolveStepIndex(stepIndex, skipOptions, 'forward')
  const progressStepIndex = Math.max(
    0,
    progressSteps.findIndex(({ index }) => index === displayedStepIndex)
  )
  // Why: pin start time once so onboarding_completed reports a real funnel duration.
  const [initialStartTime] = useState(() => Date.now())
  const startTimeRef = useRef<number>(initialStartTime)

  // Why: ref so the unmount-only revert reads the freshest theme without retriggering on each settings change.
  const persistedThemeRef = useRef<GlobalSettings['theme']>(settings?.theme ?? 'dark')
  persistedThemeRef.current = settings?.theme ?? 'dark'
  const themeStepEntryThemeRef = useRef<GlobalSettings['theme'] | null>(null)
  const themeStepEntryCapturedRef = useRef(false)
  useEffect(() => {
    if (currentStep.id !== 'theme') {
      themeStepEntryCapturedRef.current = false
      return
    }
    if (!settings || themeStepEntryCapturedRef.current) {
      return
    }
    // Why: capture entry theme so "Skip to project setup" keeps the preference the user arrived with.
    themeStepEntryCapturedRef.current = true
    themeStepEntryThemeRef.current = settings.theme
  }, [currentStep.id, settings])

  // Apply preview when local theme changes.
  useEffect(() => {
    applyDocumentTheme(theme)
  }, [theme])

  useEffect(() => {
    void refreshPreflightStatus()
  }, [refreshPreflightStatus])

  const getNextStepIndex = useCallback(
    (idx: number): number => resolveStepIndex(idx + 1, skipOptions, 'forward'),
    [skipOptions]
  )

  useEffect(() => {
    if (currentStep.id !== 'integrations' || !preflightStatusChecked || !skipIntegrations) {
      return
    }
    const nextIndex = getNextStepIndex(stepIndex)
    setStepIndex(nextIndex)
    // Why: persistence must resume at the next visible step, not bounce back through skipped optional pages.
    const skippedThroughStepNumber = Math.max(
      currentStep.stepNumber,
      STEPS[nextIndex].stepNumber - 1
    )
    void persistStep(skippedThroughStepNumber).then(onOnboardingChange, (err) => {
      toast.error(
        translate(
          'auto.components.onboarding.use.onboarding.flow.52acfbef51',
          'Could not save progress'
        ),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
    })
  }, [
    currentStep.id,
    currentStep.stepNumber,
    getNextStepIndex,
    onOnboardingChange,
    preflightStatusChecked,
    skipIntegrations,
    stepIndex
  ])

  const { consumeStepDurationMs, setLifecycleRootRef, trackTaskSourcesSnapshot } =
    useOnboardingFlowTelemetry({
      remappedLastCompletedStep,
      currentStep,
      persistedThemeRef,
      preflightStatus,
      preflightStatusLoading,
      linearStatus,
      linearStatusChecked
    })

  const closeWith = useCloseWith({
    onOnboardingChange,
    startTimeRef,
    setError
  })

  const persistCurrentStep = usePersistCurrentStep({
    currentStepId: currentStep.id,
    selectedAgent,
    yoloPermissions,
    agentStatusHooksEnabled,
    theme,
    settings,
    updateSettings,
    onboardingChecklist: onboarding.checklist,
    onOnboardingChange,
    setError
  })

  const { next, skipToRepo, dismissOnboarding, back, jumpToStep } = useOnboardingFlowActions({
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
  })

  return {
    settings,
    updateSettings,
    stepIndex,
    progressSteps,
    progressStepIndex,
    currentStep,
    selectedAgent,
    setSelectedAgent,
    yoloPermissions,
    setYoloPermissions,
    agentStatusHooksEnabled,
    setAgentStatusHooksEnabled,
    theme,
    setTheme: setThemeInteractive,
    busyLabel,
    detectedSet,
    isDetectingAgents,
    next,
    skipToRepo,
    dismissOnboarding,
    back,
    jumpToStep,
    setLifecycleRootRef
  }
}
