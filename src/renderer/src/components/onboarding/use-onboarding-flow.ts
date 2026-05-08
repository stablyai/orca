import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { applyDocumentTheme } from '@/lib/document-theme'
import { track } from '@/lib/telemetry'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { GlobalSettings, OnboardingState, TuiAgent } from '../../../../shared/types'
import type { NotificationDraft } from './NotificationStep'
import { STEPS, type StepNumber } from './use-onboarding-flow-types'
import {
  persistStep,
  useCloseWith,
  usePersistCurrentStep
} from './use-onboarding-flow-persistence'

export { STEPS } from './use-onboarding-flow-types'
export type { StepId, StepNumber } from './use-onboarding-flow-types'

export type OnboardingFlowController = ReturnType<typeof useOnboardingFlow>

export function useOnboardingFlow(
  onboarding: OnboardingState,
  onOnboardingChange: (state: OnboardingState) => void
) {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const isDetectingAgents = useAppStore(
    (s) => s.isDetectingAgents || s.isRefreshingAgents
  )
  const fetchRepos = useAppStore((s) => s.fetchRepos)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const openModal = useAppStore((s) => s.openModal)

  const initialStep = Math.min(Math.max(onboarding.lastCompletedStep, 0), STEPS.length - 1)
  const [stepIndex, setStepIndex] = useState(initialStep)
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  )
  // Why: hydrate theme from saved settings instead of hardcoding 'dark' so users
  // who already configured a theme see their choice preselected.
  const [theme, setTheme] = useState<GlobalSettings['theme']>(settings?.theme ?? 'dark')
  // Why: wizard force-defaults every toggle on (ignoring stored settings) so
  // first-run users land in the most attentive state and choose what to dial
  // back. Positive framing ("Notify when focused") inverts back to the
  // persisted `suppressWhenFocused` field at save time.
  const [notifications, setNotifications] = useState<NotificationDraft>({
    agentTaskComplete: true,
    terminalBell: true,
    notifyWhenFocused: true
  })
  const [cloneUrl, setCloneUrl] = useState('')
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Why: settings load async; the lazy useState initializers above run before
  // settings hydrates. Re-sync once when settings transitions to non-null,
  // unless the user has already interacted with that field.
  const themeInteractedRef = useRef(false)
  const agentInteractedRef = useRef(false)
  const settingsHydratedRef = useRef(false)
  useEffect(() => {
    if (!settings || settingsHydratedRef.current) {
      return
    }
    settingsHydratedRef.current = true
    if (!themeInteractedRef.current) {
      setTheme(settings.theme)
    }
    if (!agentInteractedRef.current) {
      const fromSettings =
        settings.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
          ? settings.defaultTuiAgent
          : null
      if (fromSettings !== null) {
        setSelectedAgent(fromSettings)
      }
    }
  }, [settings])

  // Why: track user interaction so async settings hydration above doesn't
  // overwrite a value the user explicitly chose.
  const setThemeInteractive = useCallback((value: GlobalSettings['theme']) => {
    themeInteractedRef.current = true
    setTheme(value)
  }, [])
  const setSelectedAgentInteractive = useCallback((value: TuiAgent | null) => {
    agentInteractedRef.current = true
    setSelectedAgent(value)
  }, [])

  const detectedSet = useMemo(() => new Set(detectedAgentIds ?? []), [detectedAgentIds])
  const currentStep = STEPS[stepIndex]

  // Why: pin start time once so onboarding_completed reports a real funnel duration.
  const startTimeRef = useRef<number>(Date.now())

  // Why: track the latest persisted theme in a ref so the unmount-only revert
  // below uses the freshest value without retriggering on each settings change.
  const persistedThemeRef = useRef<GlobalSettings['theme']>(settings?.theme ?? 'dark')
  useEffect(() => {
    persistedThemeRef.current = settings?.theme ?? 'dark'
  }, [settings?.theme])

  // Apply preview when local theme changes.
  useEffect(() => {
    applyDocumentTheme(theme)
  }, [theme])

  // Why: the theme step previews on the document before persistence. Revert to
  // the persisted theme only on wizard unmount so saving (which updates
  // settings.theme) doesn't trigger a one-frame revert/reapply flicker.
  useEffect(() => {
    return () => {
      applyDocumentTheme(persistedThemeRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Why: ref guard prevents StrictMode's double-invoke from emitting
  // `onboarding_started` twice on mount.
  const startedTrackedRef = useRef(false)
  useEffect(() => {
    if (startedTrackedRef.current) {
      return
    }
    startedTrackedRef.current = true
    // Why: `resumed_from_step` is the step the user finished (1..3), not the
    // step we resume into.
    const lastCompleted = onboarding.lastCompletedStep
    track(
      'onboarding_started',
      lastCompleted >= 1 && lastCompleted <= 3
        ? { resumed_from_step: lastCompleted as StepNumber }
        : {}
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    track('onboarding_step_viewed', { step: currentStep.stepNumber })
  }, [currentStep.stepNumber])

  // Why: only auto-pick on first mount when detection completes; otherwise
  // selecting an agent would re-trigger this effect and clobber/race user clicks.
  const didAutoSelectRef = useRef(false)
  const selectedAgentRef = useRef(selectedAgent)
  useEffect(() => {
    selectedAgentRef.current = selectedAgent
  }, [selectedAgent])
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
    async (repoId: string, isGit: boolean, path: 'open_folder' | 'clone_url') => {
      await fetchRepos()
      await fetchWorktrees(repoId)
      const worktree = useAppStore.getState().worktreesByRepo[repoId]?.[0]
      if (worktree) {
        activateAndRevealWorktree(worktree.id)
      }
      // Why: next() short-circuits step 4, so emit step_completed here once the
      // repo is successfully added to keep the funnel consistent. Gate on
      // closeWith's success so a persistence failure doesn't double-count.
      const closed = await closeWith(
        'completed',
        isGit ? { addedRepo: true } : { addedFolder: true },
        4,
        path
      )
      if (!closed) {
        return
      }
      track('onboarding_step_completed', { step: 4, value_kind: 'repo' })
      if (isGit) {
        openModal('new-workspace-composer', {
          initialRepoId: repoId,
          prefilledName: 'onboarding',
          telemetrySource: 'onboarding'
        })
      }
    },
    [closeWith, fetchRepos, fetchWorktrees, openModal]
  )

  const persistCurrentStep = usePersistCurrentStep({
    currentStepId: currentStep.id,
    selectedAgent,
    theme,
    notifications,
    settings,
    updateSettings,
    onboardingChecklist: onboarding.checklist,
    onOnboardingChange,
    setError
  })

  const next = useCallback(async () => {
    if (busyLabel || currentStep.id === 'repo') {
      return
    }
    const ok = await persistCurrentStep()
    if (ok) {
      track('onboarding_step_completed', {
        step: currentStep.stepNumber,
        value_kind: currentStep.valueKind
      })
      setStepIndex((idx) => Math.min(idx + 1, STEPS.length - 1))
    }
  }, [busyLabel, currentStep.id, currentStep.stepNumber, currentStep.valueKind, persistCurrentStep])

  const openFolder = useCallback(async () => {
    // Why: re-entry guard — rapid Cmd+Enter must not launch duplicate pickers.
    if (busyLabel !== null) {
      return
    }
    setError(null)
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
      setBusyLabel(null)
    }
  }, [busyLabel, completeRepo])

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
    setBusyLabel('Cloning repo…')
    try {
      const repo = await window.api.repos.clone({ url: trimmed, destination: settings.workspaceDir })
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
  }, [busyLabel, cloneUrl, completeRepo, settings])

  const skip = useCallback(async () => {
    if (busyLabel) {
      return
    }
    track('onboarding_step_skipped', { step: currentStep.stepNumber })
    // Why: theme step previews on the document without persisting. On skip,
    // revert to the saved theme before advancing so the preview doesn't leak.
    if (currentStep.id === 'theme' && settings) {
      setTheme(settings.theme)
      applyDocumentTheme(settings.theme)
    }
    if (currentStep.id === 'repo') {
      await closeWith('dismissed', {}, currentStep.stepNumber)
      return
    }
    // Why: persistence-only path — does NOT trigger requestPermission, so
    // skipping step 3 never fires the OS permission prompt.
    try {
      onOnboardingChange(await persistStep(currentStep.stepNumber))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    setStepIndex((idx) => Math.min(idx + 1, STEPS.length - 1))
  }, [busyLabel, closeWith, currentStep.id, currentStep.stepNumber, onOnboardingChange, settings])

  const back = useCallback(() => {
    setStepIndex((idx) => Math.max(idx - 1, 0))
  }, [])

  return {
    settings,
    updateSettings,
    stepIndex,
    currentStep,
    selectedAgent,
    setSelectedAgent: setSelectedAgentInteractive,
    theme,
    setTheme: setThemeInteractive,
    notifications,
    setNotifications,
    cloneUrl,
    setCloneUrl,
    busyLabel,
    error,
    detectedSet,
    isDetectingAgents,
    next,
    skip,
    back,
    openFolder,
    clone
  }
}
