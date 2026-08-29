import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { applyDocumentTheme } from '@/lib/document-theme'
import { track } from '@/lib/telemetry'
import { buildAgentPickedPayload } from './agent-picked-payload'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { STEPS } from './use-onboarding-flow-types'
import { persistStep, useCloseWith, usePersistCurrentStep } from './use-onboarding-flow-persistence'
import { resolveOnboardingSettingsHydration } from './onboarding-settings-hydration'
import { translate } from '@/i18n/i18n'
import { resolveAgentPermissionModeSummary } from '../../../../shared/tui-agent-permissions'
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
  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const isDetectingAgents = useAppStore((s) => s.isDetectingAgents || s.isRefreshingAgents)
  const pathSource = useAppStore((s) => s.pathSource)
  const pathFailureReason = useAppStore((s) => s.pathFailureReason)
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
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  )
  const [yoloPermissions, setYoloPermissions] = useState(
    resolveAgentPermissionModeSummary({
      agentDefaultArgs: settings?.agentDefaultArgs,
      agentDefaultEnv: settings?.agentDefaultEnv
    }) !== 'manual'
  )
  // Why: hydrate theme from saved settings so users who already chose one see it preselected.
  const [theme, setTheme] = useState<GlobalSettings['theme']>(settings?.theme ?? 'dark')
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [, setError] = useState<string | null>(null)

  // Why: settings hydrate async after the lazy initializers run; re-sync once before commit unless the user edited the field.
  const themeInteractedRef = useRef(false)
  const agentInteractedRef = useRef(false)
  const yoloPermissionsInteractedRef = useRef(false)
  const [settingsHydrated, setSettingsHydrated] = useState(settings != null)
  const settingsHydration = resolveOnboardingSettingsHydration({
    settings,
    settingsHydrated,
    themeInteracted: themeInteractedRef.current,
    agentInteracted: agentInteractedRef.current,
    currentTheme: theme,
    currentAgent: selectedAgent
  })
  if (settingsHydration) {
    setSettingsHydrated(settingsHydration.settingsHydrated)
    if (settingsHydration.theme !== undefined) {
      setTheme(settingsHydration.theme)
    }
    if (settingsHydration.selectedAgent !== undefined) {
      setSelectedAgent(settingsHydration.selectedAgent)
    }
  }
  if (settings && !yoloPermissionsInteractedRef.current) {
    const nextYoloPermissions =
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: settings.agentDefaultArgs,
        agentDefaultEnv: settings.agentDefaultEnv
      }) !== 'manual'
    if (nextYoloPermissions !== yoloPermissions) {
      setYoloPermissions(nextYoloPermissions)
    }
  }

  // Why: track interaction so async settings hydration doesn't overwrite a value the user chose.
  const setThemeInteractive = useCallback((value: GlobalSettings['theme']) => {
    themeInteractedRef.current = true
    setTheme(value)
  }, [])
  // `fromCollapsedSection`: whether the picked agent lived under AgentStep's `<details>` disclosure — only that call site knows.
  const detectedAgentIdsRef = useRef<readonly TuiAgent[]>(detectedAgentIds ?? [])
  const isDetectingRef = useRef<boolean>(isDetectingAgents)
  const selectedAgentRef = useRef(selectedAgent)
  // Why: refs let the stable `setSelectedAgentInteractive` read the freshest hydration classification at click time.
  const pathSourceRef = useRef(pathSource)
  const pathFailureReasonRef = useRef(pathFailureReason)
  // Why: keep these mirrors fresh so stable handlers read current values at click/async time.
  selectedAgentRef.current = selectedAgent
  detectedAgentIdsRef.current = detectedAgentIds ?? []
  isDetectingRef.current = isDetectingAgents
  pathSourceRef.current = pathSource
  pathFailureReasonRef.current = pathFailureReason
  const setSelectedAgentInteractive = useCallback(
    (value: TuiAgent | null, fromCollapsedSection = false) => {
      agentInteractedRef.current = true
      // Why: de-dup re-clicks on the current agent so telemetry counts mind-changes, not idle reselection.
      const prev = selectedAgentRef.current
      setSelectedAgent(value)
      if (value === null || value === prev) {
        return
      }
      // Why: emit at click time (not step completion) to capture mind-changes; payload builder extracted for coverage — see agent-picked-payload.test.ts.
      track(
        'onboarding_agent_picked',
        buildAgentPickedPayload({
          agent: value,
          detectedAgentIds: detectedAgentIdsRef.current,
          isDetecting: isDetectingRef.current,
          fromCollapsedSection,
          pathSource: pathSourceRef.current,
          pathFailureReason: pathFailureReasonRef.current
        })
      )
    },
    []
  )
  const setYoloPermissionsInteractive = useCallback((enabled: boolean) => {
    yoloPermissionsInteractedRef.current = true
    setYoloPermissions(enabled)
  }, [])

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
  const startTimeRef = useRef<number>(Date.now())

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

  // Why: auto-pick only on first mount; otherwise re-running would clobber/race the user's own agent selection.
  const didAutoSelectRef = useRef(false)
  useEffect(() => {
    if (didAutoSelectRef.current) {
      return
    }
    didAutoSelectRef.current = true
    // Why: re-read PATH on mount; the session cache can be poisoned by callers that ran before shell PATH hydration, giving a false "no agents" state.
    void refreshDetectedAgents().then((ids) => {
      if (selectedAgentRef.current !== null) {
        return
      }
      const preferred = getAgentCatalog().find((agent) => ids.includes(agent.id))?.id ?? null
      setSelectedAgent(preferred)
    })
  }, [refreshDetectedAgents])

  const closeWith = useCloseWith({
    onOnboardingChange,
    startTimeRef,
    setError
  })

  const persistCurrentStep = usePersistCurrentStep({
    currentStepId: currentStep.id,
    selectedAgent,
    yoloPermissions,
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
    setSelectedAgent: setSelectedAgentInteractive,
    yoloPermissions,
    setYoloPermissions: setYoloPermissionsInteractive,
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
