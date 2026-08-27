/* eslint-disable max-lines -- Why: single orchestrator for every onboarding-step transition; splitting would scatter ordering across hooks and lose the controller-shape contract OnboardingFlow.tsx consumes. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { applyDocumentTheme } from '@/lib/document-theme'
import { track } from '@/lib/telemetry'
import { buildAgentPickedPayload } from './agent-picked-payload'
import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../../shared/constants'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { STEPS, type StepNumber } from './use-onboarding-flow-types'
import { persistStep, useCloseWith, usePersistCurrentStep } from './use-onboarding-flow-persistence'
import { resolveOnboardingSettingsHydration } from './onboarding-settings-hydration'
import { translate } from '@/i18n/i18n'
import { resolveAgentPermissionModeSummary } from '../../../../shared/tui-agent-permissions'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { buildWindowsTerminalSnapshotPayload } from './windows-terminal-onboarding-telemetry'

export { STEPS } from './use-onboarding-flow-types'
export type { StepId, StepNumber } from './use-onboarding-flow-types'

type TaskSourcesSnapshotProps = EventProps<'onboarding_task_sources_snapshot'>
type TaskSourcesGithubStatus = TaskSourcesSnapshotProps['github_status']
type TaskSourcesLinearStatus = TaskSourcesSnapshotProps['linear_status']
type TaskSourcesExitAction = TaskSourcesSnapshotProps['exit_action']

function shouldSkipIntegrationsStep(
  status: ReturnType<typeof useAppStore.getState>['preflightStatus']
): boolean {
  return status?.gh.installed === true
}

function shouldSkipWindowsTerminalStep(isWindows: boolean): boolean {
  return !isWindows
}

type OnboardingStepSkipOptions = {
  skipIntegrations: boolean
  skipWindowsTerminal: boolean
}

function isSkippedStepIndex(index: number, options: OnboardingStepSkipOptions): boolean {
  const step = STEPS[index]
  return (
    (options.skipIntegrations && step?.id === 'integrations') ||
    (options.skipWindowsTerminal && step?.id === 'windows_terminal')
  )
}

function resolveStepIndex(
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

function getGitHubTaskSourceStatus(
  status: ReturnType<typeof useAppStore.getState>['preflightStatus'],
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

function getLinearTaskSourceStatus(
  status: ReturnType<typeof useAppStore.getState>['linearStatus'],
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

  const getPreviousStepIndex = useCallback(
    (idx: number): number => resolveStepIndex(idx - 1, skipOptions, 'backward'),
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

  // Why: ref guard stops StrictMode's double-invoke from emitting onboarding_started twice.
  const startedTrackedRef = useRef(false)
  useEffect(() => {
    if (startedTrackedRef.current) {
      return
    }
    startedTrackedRef.current = true
    // Why: resumed_from_step is the step the user finished, not the one we resume into.
    const lastCompleted = remappedLastCompletedStep
    track(
      'onboarding_started',
      lastCompleted >= 1 && lastCompleted < ONBOARDING_FINAL_STEP
        ? { resumed_from_step: lastCompleted as StepNumber }
        : {}
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Why: re-pinned per step view so duration_ms measures only post-resume time; optional so a missing baseline drops the field, not the event. See docs/onboarding-telemetry-extensions.md.
  const stepStartedAtRef = useRef<number>(Date.now())
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

  const setLifecycleRootRef = useCallback((node: HTMLElement | null): void => {
    if (node !== null) {
      return
    }
    // Why: theme preview mutates state outside this component, so revert on modal-root detach rather than a passive Effect.
    applyDocumentTheme(persistedThemeRef.current)
  }, [])

  const trackTaskSourcesSnapshot = useCallback(
    (
      exitAction: TaskSourcesExitAction,
      durationMs: number,
      advancedVia: 'button' | 'keyboard'
    ): void => {
      // Why: one low-cardinality snapshot captures task-source usability at step exit without per-button telemetry.
      track('onboarding_task_sources_snapshot', {
        github_status: getGitHubTaskSourceStatus(preflightStatus, preflightStatusLoading),
        linear_status: getLinearTaskSourceStatus(linearStatus, linearStatusChecked),
        exit_action: exitAction,
        duration_ms: durationMs,
        advanced_via: advancedVia
      })
    },
    [linearStatus, linearStatusChecked, preflightStatus, preflightStatusLoading]
  )

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
      trackCurrentStepCompleted
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
    updateSettings
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
    [busyLabel, closeWith, consumeStepDurationMs, currentStep.stepNumber]
  )

  const back = useCallback(() => {
    setStepIndex(getPreviousStepIndex)
  }, [getPreviousStepIndex])

  const jumpToStep = useCallback(
    (idx: number) => {
      setStepIndex(resolveStepIndex(idx, skipOptions, idx < stepIndex ? 'backward' : 'forward'))
    },
    [skipOptions, stepIndex]
  )

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
