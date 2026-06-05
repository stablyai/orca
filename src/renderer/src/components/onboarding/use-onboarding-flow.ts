/* eslint-disable max-lines -- Why: this hook is the single orchestrator for every onboarding-step transition (navigation, persistence, telemetry, ref-mirror, auto-select); splitting would force callers to coordinate ordering across multiple hooks and lose the controller-shape contract OnboardingFlow.tsx consumes. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
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

function isSkippedStepIndex(index: number, skipIntegrations: boolean): boolean {
  return skipIntegrations && STEPS[index]?.id === 'integrations'
}

function resolveStepIndex(
  index: number,
  skipIntegrations: boolean,
  direction: 'forward' | 'backward'
): number {
  const lastIndex = STEPS.length - 1
  let nextIndex = Math.min(Math.max(index, 0), lastIndex)
  while (isSkippedStepIndex(nextIndex, skipIntegrations)) {
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
  if (outcome === 'completed' && lastCompletedStep >= ONBOARDING_FINAL_STEP) {
    return ONBOARDING_FINAL_STEP
  }
  // Why: v2 was the five-step flow; missing/older versions were seven-step
  // data where step 4 was removed agent setup, not completed integrations.
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
    // Why: theme tiles save immediately for a stable preview, but skip still
    // means "do not keep this step's choice."
    if (currentStepId === 'theme') {
      const themeToRestore = themeBeforePreview ?? settingsTheme
      if (themeToRestore) {
        setTheme(themeToRestore)
        applyTheme(themeToRestore)
        await updateSettings({ theme: themeToRestore })
      }
    }
    // Why: the repo step seeds folder terminals from saved settings. Preserve
    // the visible agent choice when optional preferences are skipped.
    if (currentStepId === 'agent' && selectedAgent) {
      await updateSettings({ defaultTuiAgent: selectedAgent })
    }
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setError(message)
    toast.error('Could not save progress', { description: message })
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
  // Why: App hydrates repos before mounting onboarding. Reading the store
  // synchronously lets the final step render its already-added state without a flash.
  const repos = useAppStore((s) => s.repos)
  // Why: renderToStaticMarkup uses Zustand's initial server snapshot. The
  // synchronous read keeps tests and the first client render aligned.
  const effectivePreflightStatus = preflightStatus ?? useAppStore.getState().preflightStatus

  const skipIntegrations = shouldSkipIntegrationsStep(effectivePreflightStatus)
  const remappedLastCompletedStep = remapOpenOnboardingLastCompletedStep(onboarding)
  const initialStep = resolveStepIndex(
    Math.min(Math.max(remappedLastCompletedStep, 0), STEPS.length - 1),
    skipIntegrations,
    'forward'
  )
  const [stepIndex, setStepIndex] = useState(initialStep)
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  )
  // Why: hydrate theme from saved settings instead of hardcoding 'dark' so users
  // who already configured a theme see their choice preselected.
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

  // Why: settings load async; the lazy useState initializers above run before
  // settings hydrates. Re-sync once before commit so children never paint the
  // fallback defaults, unless the user already interacted with that field.
  const themeInteractedRef = useRef(false)
  const agentInteractedRef = useRef(false)
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

  // Why: track user interaction so async settings hydration above doesn't
  // overwrite a value the user explicitly chose.
  const setThemeInteractive = useCallback((value: GlobalSettings['theme']) => {
    themeInteractedRef.current = true
    setTheme(value)
  }, [])
  // `fromCollapsedSection` is the click-site signal for whether the picked
  // agent lived under the `<details>` disclosure in AgentStep. AgentStep is
  // the only call site that has the real answer; main-side detected_count /
  // detection_state are merged in here from the store.
  const detectedAgentIdsRef = useRef<readonly TuiAgent[]>(detectedAgentIds ?? [])
  const isDetectingRef = useRef<boolean>(isDetectingAgents)
  const selectedAgentRef = useRef(selectedAgent)
  // Why: refs let `setSelectedAgentInteractive` (a stable useCallback) read
  // the freshest hydration classification at click time. Mirrors the
  // detectedAgentIdsRef / isDetectingRef pattern.
  const pathSourceRef = useRef(pathSource)
  const pathFailureReasonRef = useRef(pathFailureReason)
  // Why: stable onboarding handlers read these values at click/async time, so
  // keep the mirrors fresh before events can run.
  selectedAgentRef.current = selectedAgent
  detectedAgentIdsRef.current = detectedAgentIds ?? []
  isDetectingRef.current = isDetectingAgents
  pathSourceRef.current = pathSource
  pathFailureReasonRef.current = pathFailureReason
  const setSelectedAgentInteractive = useCallback(
    (value: TuiAgent | null, fromCollapsedSection = false) => {
      agentInteractedRef.current = true
      // Why: de-dup re-clicks on the current agent so dashboards count
      // mind-changes only, not idle reselection of the same option.
      const prev = selectedAgentRef.current
      setSelectedAgent(value)
      if (value === null || value === prev) {
        return
      }
      // Why: emit at click time, not at step completion, so we capture
      // mind-changes within the step. The payload builder is extracted so the
      // store-fields-attached invariant has unit coverage — see
      // agent-picked-payload.test.ts.
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

  const detectedSet = useMemo(() => new Set(detectedAgentIds ?? []), [detectedAgentIds])
  const currentStep = STEPS[stepIndex]
  const visibleSteps = useMemo(
    () =>
      STEPS.map((step, index) => ({ step, index })).filter(
        ({ index }) => !isSkippedStepIndex(index, skipIntegrations)
      ),
    [skipIntegrations]
  )
  const visibleStepIndex = Math.max(
    0,
    visibleSteps.findIndex(({ index }) => index === stepIndex)
  )
  const hasExistingProject = repos.length > 0

  // Why: pin start time once so onboarding_completed reports a real funnel duration.
  const startTimeRef = useRef<number>(Date.now())

  // Why: track the latest persisted theme in a ref so the unmount-only revert
  // below uses the freshest value without retriggering on each settings change.
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
    // Why: theme tile clicks persist immediately for normal progression, but
    // "Skip to project setup" should keep the preference the user arrived with.
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
    (idx: number): number => resolveStepIndex(idx + 1, skipIntegrations, 'forward'),
    [skipIntegrations]
  )

  const getPreviousStepIndex = useCallback(
    (idx: number): number => resolveStepIndex(idx - 1, skipIntegrations, 'backward'),
    [skipIntegrations]
  )

  useEffect(() => {
    if (currentStep.id !== 'integrations' || !preflightStatusChecked || !skipIntegrations) {
      return
    }
    const nextIndex = getNextStepIndex(stepIndex)
    setStepIndex(nextIndex)
    // Why: users with gh already on PATH don't need this setup page, but
    // persistence must still resume them at repo setup instead of bouncing back.
    void persistStep(currentStep.stepNumber).then(onOnboardingChange, (err) => {
      toast.error('Could not save progress', {
        description: err instanceof Error ? err.message : String(err)
      })
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

  // Why: ref guard prevents StrictMode's double-invoke from emitting
  // `onboarding_started` twice on mount.
  const startedTrackedRef = useRef(false)
  useEffect(() => {
    if (startedTrackedRef.current) {
      return
    }
    startedTrackedRef.current = true
    // Why: `resumed_from_step` is the step the user finished, not the
    // step we resume into.
    const lastCompleted = remappedLastCompletedStep
    track(
      'onboarding_started',
      lastCompleted >= 1 && lastCompleted < ONBOARDING_FINAL_STEP
        ? { resumed_from_step: lastCompleted as StepNumber }
        : {}
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Session-local step duration: re-pinned on every step view so a resumed
  // user emits `duration_ms` for the visible step measuring only the
  // post-resume time. Optional on the schema so a missing baseline (e.g. the
  // _viewed effect was skipped or StrictMode double-mounted) fail-soft drops
  // the field rather than the event. See docs/onboarding-telemetry-extensions.md.
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
    // Why: onboarding previews theme state outside this component; tie
    // final cleanup to the modal root detaching instead of passive Effects.
    applyDocumentTheme(persistedThemeRef.current)
  }, [])

  const trackTaskSourcesSnapshot = useCallback(
    (
      exitAction: TaskSourcesExitAction,
      durationMs: number,
      advancedVia: 'button' | 'keyboard'
    ): void => {
      // Why: one low-cardinality snapshot answers whether task sources were
      // usable at step exit without paying for per-button telemetry.
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

  // Why: only auto-pick on first mount when detection completes; otherwise
  // selecting an agent would re-trigger this effect and clobber/race user clicks.
  const didAutoSelectRef = useRef(false)
  useEffect(() => {
    if (didAutoSelectRef.current) {
      return
    }
    didAutoSelectRef.current = true
    // Why: re-read PATH on wizard mount instead of reusing the session cache.
    // The cache can be poisoned if a prior caller ran before shell PATH
    // hydration finished, leaving the wizard with a false "no agents" state.
    void refreshDetectedAgents().then((ids) => {
      if (selectedAgentRef.current !== null) {
        return
      }
      const preferred = AGENT_CATALOG.find((agent) => ids.includes(agent.id))?.id ?? null
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
      // Why: once the project is persisted, a non-authoritative Git refresh
      // should still complete onboarding onto the project row as a fallback.
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
          // Why: onboarding asks for a default agent immediately before this step.
          // Non-git folders skip the composer, so seed their first terminal here.
          const startup = buildOnboardingFolderAgentStartup(settings)
          activateAndRevealWorktree(worktree.id, { startup })
        }
      }
      // Why: next() short-circuits the repo step, so emit step_completed here
      // once the repo is successfully added to keep the funnel consistent.
      // Gate on closeWith's success so a persistence failure doesn't
      // double-count.
      const closed = await closeWith(
        'completed',
        isGit ? { addedRepo: true } : { addedFolder: true },
        ONBOARDING_FINAL_STEP,
        path
      )
      if (!closed) {
        return
      }
      // Why: the repo step has no keyboard-vs-button advance — Cmd+Enter
      // routes to `openFolder()` which collapses both into the path-clicked
      // path. Emit `duration_ms` only; `advanced_via` is intentionally absent
      // for the final step. See docs/onboarding-telemetry-extensions.md §3.
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
    theme,
    settings,
    updateSettings,
    onboardingChecklist: onboarding.checklist,
    onOnboardingChange,
    setError
  })

  // Why: synchronous re-entry latch. `busyLabel` is React state and only
  // commits after the awaited persistCurrentStep round-trip resolves, so a
  // second Cmd+Enter (auto-repeat fires every ~30ms) re-enters next() before
  // the first call's setStepIndex has run, advancing twice and skipping a
  // step. A ref flips synchronously so re-entries bail immediately.
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
    },
    [
      consumeStepDurationMs,
      currentStep.id,
      currentStep.stepNumber,
      currentStep.valueKind,
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
          if (
            currentStep.id === 'theme' &&
            skipIntegrations &&
            STEPS[nextIndex]?.id === 'notifications'
          ) {
            // Why: resolveStepIndex skips integrations before it can render, but
            // progress must still resume at notifications after a reload.
            try {
              onOnboardingChange(await persistStep(STEPS[nextIndex].stepNumber - 1))
            } catch (err) {
              toast.error('Could not save progress', {
                description: err instanceof Error ? err.message : String(err)
              })
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
      getNextStepIndex,
      onOnboardingChange,
      openModal,
      persistCurrentStep,
      skipIntegrations,
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
          const message = 'Enter a server path.'
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
        // Why: Set insertion order can drift after deselect/reselect; import
        // ordering should match the visible scan order users reviewed.
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
        // Why: imported repos are already persisted; non-authoritative SSH
        // refreshes should not block onboarding from revealing the first project.
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

  // Why: lets the user back out of the nested-repo step in onboarding to
  // re-pick a folder/clone target. Mirrors the dialog's left-aligned Back.
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
      const message = 'Enter a server path for the clone destination.'
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
      toast.error('Clone failed', {
        description: err instanceof Error ? err.message : String(err)
      })
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
      // Why: the repo picker moved to the Add Project dialog, so skipping
      // optional setup now closes onboarding and hands off to that modal.
      track('onboarding_step_skipped', {
        step: stepNumber,
        value_kind: valueKind,
        duration_ms: durationMs,
        advanced_via: 'button'
      })
      if (stepId === 'integrations') {
        trackTaskSourcesSnapshot('skip_to_project_setup', durationMs, 'button')
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
      toast.error('Could not open SSH settings', { description: message })
      return
    }
    // Why: Settings renders behind the fullscreen onboarding layer; SSH users
    // need a temporary detour without marking required repo setup dismissed.
    onSettingsDetourStart?.()
    // Why: keep the target in the store before the Settings view mounts. A
    // timer here can run before the lazy view subscribes and strand users on
    // the default General pane.
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
      setStepIndex(
        resolveStepIndex(idx, skipIntegrations, idx < stepIndex ? 'backward' : 'forward')
      )
    },
    [nestedScan, skipIntegrations, stepIndex, trackNestedBackAndClear]
  )

  return {
    settings,
    updateSettings,
    stepIndex,
    visibleSteps,
    visibleStepIndex,
    currentStep,
    selectedAgent,
    setSelectedAgent: setSelectedAgentInteractive,
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
