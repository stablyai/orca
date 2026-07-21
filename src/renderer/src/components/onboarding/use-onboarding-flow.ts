/* eslint-disable max-lines -- Why: single orchestrator for every onboarding-step transition; splitting would scatter ordering across hooks and lose the controller-shape contract OnboardingFlow.tsx consumes. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { applyDocumentTheme } from '@/lib/document-theme'
import { track } from '@/lib/telemetry'
import { getSelectedNestedRepoPathsInScanOrder } from '@/lib/nested-repo-selected-paths'
import { buildAgentPickedPayload } from './agent-picked-payload'
import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../../shared/constants'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  buildNestedRepoScanTelemetry,
  createNestedRepoTelemetryAttemptId,
  shouldEmitNestedRepoImportSubmitTelemetry,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../shared/nested-repo-telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'
import type {
  GlobalSettings,
  NestedRepoScanResult,
  OnboardingState,
  Repo,
  TuiAgent
} from '../../../../shared/types'
import { STEPS, type StepNumber } from './use-onboarding-flow-types'
import { persistStep, useCloseWith, usePersistCurrentStep } from './use-onboarding-flow-persistence'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { buildOnboardingFolderAgentStartup } from '@/lib/onboarding-folder-agent-startup'
import { resolveOnboardingSettingsHydration } from './onboarding-settings-hydration'
import { openProjectDefaultCheckout } from '../sidebar/project-added-default-checkout'
import { translate } from '@/i18n/i18n'
import { resolveAgentPermissionModeSummary } from '../../../../shared/tui-agent-permissions'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { buildWindowsTerminalSnapshotPayload } from './windows-terminal-onboarding-telemetry'

export { STEPS } from './use-onboarding-flow-types'
export type { StepId, StepNumber } from './use-onboarding-flow-types'

export type OnboardingFlowController = ReturnType<typeof useOnboardingFlow>

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

function createNestedRepoScanId(): string {
  return `nested-repo-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
    // Why: the repo step seeds folder terminals from saved settings, so preserve the visible agent choice on skip.
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
  onOnboardingChange: (state: OnboardingState) => void,
  options: { onSettingsDetourStart?: () => void } = {}
) {
  const { onSettingsDetourStart } = options
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const isDetectingAgents = useAppStore((s) => s.isDetectingAgents || s.isRefreshingAgents)
  const pathSource = useAppStore((s) => s.pathSource)
  const pathFailureReason = useAppStore((s) => s.pathFailureReason)
  const fetchRepos = useAppStore((s) => s.fetchRepos)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const scanNestedRepos = useAppStore((s) => s.scanNestedRepos)
  const cancelNestedRepoScan = useAppStore((s) => s.cancelNestedRepoScan)
  const importNestedRepos = useAppStore((s) => s.importNestedRepos)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  // Why: repos are hydrated before onboarding mounts; the sync read lets the final step render added state without a flash.
  const repos = useAppStore((s) => s.repos)
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
  const [cloneUrl, setCloneUrl] = useState('')
  const [serverPath, setServerPath] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [nestedScan, setNestedScan] = useState<NestedRepoScanResult | null>(null)
  const [nestedSelectedPaths, setNestedSelectedPaths] = useState<Set<string>>(new Set())
  const [nestedAttemptId, setNestedAttemptId] = useState<string | null>(null)
  const [nestedRuntimeKind, setNestedRuntimeKind] = useState<NestedRepoTelemetryRuntimeKind | null>(
    null
  )
  const [nestedScanInProgress, setNestedScanInProgress] = useState(false)
  const [nestedImportScanId, setNestedImportScanId] = useState<string | null>(null)
  const nestedScanIdRef = useRef<string | null>(null)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  const hasExistingProject = repos.length > 0

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
    onboardingChecklist: onboarding.checklist,
    startTimeRef,
    setError
  })

  const completeRepo = useCallback(
    async (projectId: string, isGit: boolean, path: 'open_folder' | 'clone_url') => {
      await fetchRepos()
      // Why: a non-authoritative Git refresh should still complete onboarding onto the project row as a fallback.
      await fetchWorktrees(projectId, isGit ? { requireAuthoritative: true } : undefined)
      const worktrees = useAppStore.getState().worktreesByRepo[projectId] ?? []
      if (isGit) {
        await openProjectDefaultCheckout({
          repoId: projectId,
          source: path === 'clone_url' ? 'onboarding_clone_url' : 'onboarding_open_folder',
          setHideDefaultBranchWorkspace
        })
      } else {
        const worktree = worktrees[0] ?? null
        if (worktree) {
          // Why: non-git folders skip the composer, so seed their first terminal with the chosen default agent here.
          const startup = buildOnboardingFolderAgentStartup(settings)
          activateAndRevealWorktree(worktree.id, { startup })
        }
      }
      // Why: next() short-circuits the repo step; emit step_completed here, gated on closeWith success so a persistence failure can't double-count.
      const closed = await closeWith(
        'completed',
        isGit ? { addedRepo: true } : { addedFolder: true },
        ONBOARDING_FINAL_STEP,
        path
      )
      if (!closed) {
        return
      }
      // Why: the final repo step has no keyboard-vs-button distinction, so emit duration_ms without advanced_via. See docs/onboarding-telemetry-extensions.md §3.
      track('onboarding_step_completed', {
        step: ONBOARDING_FINAL_STEP,
        value_kind: 'repo',
        duration_ms: consumeStepDurationMs()
      })
    },
    [
      closeWith,
      consumeStepDurationMs,
      fetchRepos,
      fetchWorktrees,
      setHideDefaultBranchWorkspace,
      settings
    ]
  )

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
            const closed = await closeWith(
              'completed',
              {},
              ONBOARDING_FINAL_STEP,
              'add_project_modal'
            )
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

  const showNestedRepoReview = useCallback(
    (
      scan: NestedRepoScanResult,
      attemptId: string,
      runtimeKind: NestedRepoTelemetryRuntimeKind,
      inProgress = false,
      scanId: string | null = null
    ) => {
      setNestedScan(scan)
      setNestedSelectedPaths(new Set(scan.repos.map((repo) => repo.path)))
      setNestedAttemptId(attemptId)
      setNestedRuntimeKind(runtimeKind)
      setNestedScanInProgress(inProgress)
      setNestedImportScanId(scanId)
    },
    []
  )

  const onboardingNestedRepoRuntimeKind: NestedRepoTelemetryRuntimeKind =
    settings?.activeRuntimeEnvironmentId?.trim() ? 'runtime' : 'local'

  const openFolder = useCallback(
    async (kind: 'git' | 'folder' = 'git') => {
      // Why: re-entry guard — rapid Cmd+Enter must not launch duplicate pickers.
      if (busyLabel !== null) {
        return
      }
      setError(null)
      if (settings?.activeRuntimeEnvironmentId?.trim()) {
        const path = serverPath.trim()
        if (!path) {
          const message = 'Enter a path on the selected host.'
          setError(message)
          return
        }
        track('onboarding_step4_path_clicked', { path: 'open_folder' })
        setBusyLabel(kind === 'git' ? 'Scanning for repositories…' : 'Opening folder…')
        try {
          if (kind === 'git') {
            const attemptId = createNestedRepoTelemetryAttemptId()
            const scan = await scanNestedRepos(path)
            track(
              'add_repo_nested_scan_result',
              buildNestedRepoScanTelemetry({
                attemptId,
                surface: 'onboarding',
                runtimeKind: 'runtime',
                scan
              })
            )
            if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
              showNestedRepoReview(scan, attemptId, 'runtime')
              return
            }
          }
          setBusyLabel(kind === 'git' ? 'Opening project…' : 'Opening folder…')
          const repo = await addRepoPath(path, kind)
          if (!repo) {
            track('onboarding_step4_path_failed', { path: 'open_folder', reason: 'invalid_path' })
            return
          }
          await completeRepo(repo.id, isGitRepoKind(repo), 'open_folder')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          track('onboarding_step4_path_failed', { path: 'open_folder', reason: 'invalid_path' })
        } finally {
          nestedScanIdRef.current = null
          setNestedScanInProgress(false)
          setBusyLabel(null)
        }
        return
      }
      track('onboarding_step4_path_clicked', { path: 'open_folder' })
      const path = await window.api.repos.pickFolder()
      if (!path) {
        track('onboarding_step4_path_failed', { path: 'open_folder', reason: 'cancelled' })
        return
      }
      setBusyLabel('Opening project…')
      try {
        let result = await window.api.repos.add({ path })
        if ('error' in result && result.error.includes('Not a valid git repository')) {
          setBusyLabel('Scanning for repositories...')
          const attemptId = createNestedRepoTelemetryAttemptId()
          const scanId = createNestedRepoScanId()
          nestedScanIdRef.current = scanId
          setNestedScanInProgress(true)
          const scan = await scanNestedRepos(path, undefined, {
            scanId,
            onProgress: (progressScan) => {
              if (
                nestedScanIdRef.current !== scanId ||
                progressScan.selectedPathKind !== 'non_git_folder' ||
                progressScan.repos.length === 0
              ) {
                return
              }
              showNestedRepoReview(progressScan, attemptId, 'local', true, scanId)
            }
          })
          if (nestedScanIdRef.current !== scanId) {
            return
          }
          nestedScanIdRef.current = null
          setNestedScanInProgress(false)
          track(
            'add_repo_nested_scan_result',
            buildNestedRepoScanTelemetry({
              attemptId,
              surface: 'onboarding',
              runtimeKind: 'local',
              scan
            })
          )
          if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
            showNestedRepoReview(scan, attemptId, 'local', false, scanId)
            return
          }
          result = await window.api.repos.add({ path, kind: 'folder' })
        }
        if ('error' in result) {
          throw new Error(result.error)
        }
        await completeRepo(result.repo.id, isGitRepoKind(result.repo), 'open_folder')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        track('onboarding_step4_path_failed', { path: 'open_folder', reason: 'invalid_path' })
      } finally {
        nestedScanIdRef.current = null
        setNestedScanInProgress(false)
        setBusyLabel(null)
      }
    },
    [
      addRepoPath,
      busyLabel,
      completeRepo,
      scanNestedRepos,
      serverPath,
      showNestedRepoReview,
      settings?.activeRuntimeEnvironmentId
    ]
  )

  const importNested = useCallback(async () => {
    const mode = 'separate'
    const attemptId = nestedAttemptId
    if (
      !nestedScan ||
      !attemptId ||
      !shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId,
        selectedCount: nestedSelectedPaths.size,
        isBusy: busyLabel !== null
      })
    ) {
      return
    }
    const foundCount = nestedScan.repos.length
    const selectedCount = nestedSelectedPaths.size
    const runtimeKind = nestedRuntimeKind ?? onboardingNestedRepoRuntimeKind
    setError(null)
    setBusyLabel('Importing repositories…')
    track(
      'add_repo_nested_import_action',
      buildNestedRepoImportActionTelemetry({
        attemptId,
        surface: 'onboarding',
        runtimeKind,
        action: 'import_separate',
        foundCount,
        selectedCount
      })
    )
    let resultTracked = false
    try {
      const selectedProjectPaths = getSelectedNestedRepoPathsInScanOrder(
        nestedScan,
        nestedSelectedPaths
      )
      const result = await importNestedRepos({
        parentPath: nestedScan.selectedPath,
        groupName: '',
        // Why: Set insertion order can drift after deselect/reselect; match the visible scan order users reviewed.
        projectPaths: selectedProjectPaths,
        ...(nestedImportScanId ? { scanId: nestedImportScanId } : {}),
        mode
      })
      track(
        'add_repo_nested_import_result',
        buildNestedRepoImportResultTelemetry({
          attemptId,
          surface: 'onboarding',
          runtimeKind,
          mode,
          foundCount,
          selectedCount,
          result
        })
      )
      resultTracked = true
      const importedRepoIds =
        result?.projects
          .map((entry) => entry.projectId)
          .filter((projectId): projectId is string => typeof projectId === 'string') ?? []
      const projectId = importedRepoIds[0]
      if (!projectId) {
        const firstFailure = result?.projects.find((entry) => entry.status === 'failed')?.error
        throw new Error(
          firstFailure ? `No repositories imported: ${firstFailure}` : 'No repositories imported'
        )
      }
      for (const importedRepoId of importedRepoIds) {
        // Why: imported repos are already persisted, so a non-authoritative SSH refresh shouldn't block revealing the first project.
        await fetchWorktrees(importedRepoId, { requireAuthoritative: true })
      }
      await completeRepo(projectId, true, 'open_folder')
    } catch (err) {
      if (!resultTracked) {
        track(
          'add_repo_nested_import_result',
          buildNestedRepoImportResultTelemetry({
            attemptId,
            surface: 'onboarding',
            runtimeKind,
            mode,
            foundCount,
            selectedCount,
            result: null
          })
        )
      }
      setError(err instanceof Error ? err.message : String(err))
      track('onboarding_step4_path_failed', { path: 'open_folder', reason: 'invalid_path' })
    } finally {
      setBusyLabel(null)
    }
  }, [
    busyLabel,
    completeRepo,
    fetchWorktrees,
    importNestedRepos,
    nestedAttemptId,
    nestedScan,
    nestedSelectedPaths,
    nestedImportScanId,
    nestedRuntimeKind,
    onboardingNestedRepoRuntimeKind
  ])

  const trackNestedBackAndClear = useCallback(() => {
    if (nestedScan && nestedAttemptId) {
      track(
        'add_repo_nested_import_action',
        buildNestedRepoImportActionTelemetry({
          attemptId: nestedAttemptId,
          surface: 'onboarding',
          runtimeKind: nestedRuntimeKind ?? onboardingNestedRepoRuntimeKind,
          action: 'back',
          foundCount: nestedScan.repos.length,
          selectedCount: nestedSelectedPaths.size
        })
      )
    }
    setNestedScan(null)
    setNestedSelectedPaths(new Set())
    setNestedAttemptId(null)
    setNestedRuntimeKind(null)
    setNestedScanInProgress(false)
    setNestedImportScanId(null)
    nestedScanIdRef.current = null
    setBusyLabel(null)
    setError(null)
  }, [
    nestedAttemptId,
    nestedRuntimeKind,
    nestedScan,
    nestedSelectedPaths.size,
    onboardingNestedRepoRuntimeKind
  ])

  // Why: lets the user back out of the nested-repo step to re-pick a folder/clone target.
  const cancelNested = useCallback(() => {
    if (busyLabel !== null && !nestedScanInProgress) {
      return
    }
    if (nestedScanInProgress && nestedScanIdRef.current) {
      void cancelNestedRepoScan(nestedScanIdRef.current)
    }
    trackNestedBackAndClear()
  }, [busyLabel, cancelNestedRepoScan, nestedScanInProgress, trackNestedBackAndClear])

  const stopNestedScan = useCallback(() => {
    const scanId = nestedScanIdRef.current
    if (!scanId) {
      return
    }
    void cancelNestedRepoScan(scanId)
  }, [cancelNestedRepoScan])

  const canImportNestedForTelemetry = useCallback((): boolean => {
    return Boolean(nestedScan && nestedAttemptId && nestedSelectedPaths.size > 0)
  }, [nestedAttemptId, nestedScan, nestedSelectedPaths.size])

  const clone = useCallback(async () => {
    // Why: re-entry guard — prevents Enter spamming from triggering duplicate clones.
    if (busyLabel !== null) {
      return
    }
    const trimmed = cloneUrl.trim()
    if (!trimmed || !settings) {
      return
    }
    setError(null)
    track('onboarding_step4_path_clicked', { path: 'clone_url' })
    const target = getActiveRuntimeTarget(settings)
    const destination =
      target.kind === 'environment' ? cloneDestination.trim() : settings.workspaceDir
    if (!destination) {
      const message = 'Enter a host path for the clone destination.'
      setError(message)
      return
    }
    setBusyLabel('Cloning repo…')
    try {
      const repo =
        target.kind === 'environment'
          ? (
              await callRuntimeRpc<{ repo: Repo }>(
                target,
                'repo.clone',
                { url: trimmed, destination },
                { timeoutMs: 10 * 60_000 }
              )
            ).repo
          : await window.api.repos.clone({
              url: trimmed,
              destination
            })
      await completeRepo(repo.id, true, 'clone_url')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      track('onboarding_step4_path_failed', { path: 'clone_url', reason: 'clone_failed' })
      toast.error(
        translate('auto.components.onboarding.use.onboarding.flow.fd74e7558e', 'Clone failed'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
    } finally {
      setBusyLabel(null)
    }
  }, [busyLabel, cloneDestination, cloneUrl, completeRepo, settings])

  const continueWithExistingProject = useCallback(
    async (advancedVia: 'button' | 'keyboard' = 'button') => {
      if (busyLabel !== null || repos.length === 0) {
        return
      }
      setError(null)
      setBusyLabel('Finishing...')
      try {
        const checklist = repos.some((repo) => isGitRepoKind(repo))
          ? { addedRepo: true }
          : { addedFolder: true }
        const closed = await closeWith('completed', checklist, ONBOARDING_FINAL_STEP)
        if (!closed) {
          return
        }
        track('onboarding_step_completed', {
          step: ONBOARDING_FINAL_STEP,
          value_kind: 'repo',
          duration_ms: consumeStepDurationMs(),
          advanced_via: advancedVia
        })
      } finally {
        setBusyLabel(null)
      }
    },
    [busyLabel, closeWith, consumeStepDurationMs, repos]
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
      const closed = await closeWith('completed', {}, ONBOARDING_FINAL_STEP, 'add_project_modal')
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
      const closed = await closeWith('dismissed', {}, currentStep.stepNumber, undefined, {
        durationMs: consumeStepDurationMs(),
        advancedVia
      })
      if (closed) {
        if (nestedScan) {
          trackNestedBackAndClear()
        }
      }
      return closed
    },
    [
      busyLabel,
      closeWith,
      consumeStepDurationMs,
      currentStep.stepNumber,
      nestedScan,
      trackNestedBackAndClear
    ]
  )

  const openSshSettings = useCallback(async () => {
    if (busyLabel) {
      return
    }
    setError(null)
    try {
      onOnboardingChange(await persistStep(currentStep.stepNumber - 1))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(
        translate(
          'auto.components.onboarding.use.onboarding.flow.dce4bdce5b',
          'Could not open SSH settings'
        ),
        { description: message }
      )
      return
    }
    // Why: SSH users need a temporary Settings detour without marking required repo setup dismissed.
    onSettingsDetourStart?.()
    // Why: set the target before the lazy Settings view mounts; a timer could fire before it subscribes and strand users on General.
    openSettingsTarget({ pane: 'ssh', repoId: null, sectionId: 'ssh' })
    openSettingsPage()
  }, [
    busyLabel,
    currentStep.stepNumber,
    onOnboardingChange,
    onSettingsDetourStart,
    openSettingsPage,
    openSettingsTarget
  ])

  const back = useCallback(() => {
    if (nestedScan) {
      trackNestedBackAndClear()
      return
    }
    setStepIndex(getPreviousStepIndex)
  }, [getPreviousStepIndex, nestedScan, trackNestedBackAndClear])

  const jumpToStep = useCallback(
    (idx: number) => {
      if (nestedScan && idx !== stepIndex) {
        trackNestedBackAndClear()
      }
      setStepIndex(resolveStepIndex(idx, skipOptions, idx < stepIndex ? 'backward' : 'forward'))
    },
    [nestedScan, skipOptions, stepIndex, trackNestedBackAndClear]
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
    cloneUrl,
    setCloneUrl,
    nestedScan,
    nestedScanInProgress,
    nestedSelectedPaths,
    setNestedSelectedPaths,
    importNested,
    cancelNested,
    stopNestedScan,
    canImportNestedForTelemetry,
    hasExistingProject,
    serverPath,
    setServerPath,
    cloneDestination,
    setCloneDestination,
    busyLabel,
    error,
    detectedSet,
    isDetectingAgents,
    next,
    skipToRepo,
    dismissOnboarding,
    back,
    jumpToStep,
    setLifecycleRootRef,
    openFolder,
    continueWithExistingProject,
    openSshSettings,
    clone
  }
}
