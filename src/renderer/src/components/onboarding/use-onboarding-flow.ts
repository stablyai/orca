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

export type StepNumber = 1 | 2 | 3 | 4
export type StepId = 'agent' | 'theme' | 'notifications' | 'repo'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'notifications' | 'repo'
}[] = [
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'notifications', stepNumber: 3, valueKind: 'notifications' },
  { id: 'repo', stepNumber: 4, valueKind: 'repo' }
]

function selectedAgentOrBlank(agent: TuiAgent | null): TuiAgent | 'blank' {
  return agent ?? 'blank'
}

async function persistStep(
  stepNumber: number,
  updates: Partial<OnboardingState> = {}
): Promise<OnboardingState> {
  return window.api.onboarding.update({
    lastCompletedStep: Math.max(stepNumber, -1),
    ...updates
  })
}

export type OnboardingFlowController = ReturnType<typeof useOnboardingFlow>

export function useOnboardingFlow(
  onboarding: OnboardingState,
  onOnboardingChange: (state: OnboardingState) => void
) {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
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

  useEffect(() => {
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

  useEffect(() => {
    void ensureDetectedAgents().then((ids) => {
      if (selectedAgent !== null) {
        return
      }
      const preferred = AGENT_CATALOG.find((agent) => ids.includes(agent.id))?.id ?? null
      setSelectedAgent(preferred)
    })
  }, [ensureDetectedAgents, selectedAgent])

  const closeWith = useCallback(
    async (
      outcome: 'completed' | 'dismissed',
      checklist: Partial<OnboardingState['checklist']>,
      lastStepReached: StepNumber,
      completedPath?: 'open_folder' | 'clone_url'
    ): Promise<boolean> => {
      let nextState: OnboardingState
      try {
        // Why: main-process updateOnboarding already merges with current state,
        // so spreading the local (potentially stale) onboarding.checklist would
        // overwrite concurrent updates.
        nextState = await window.api.onboarding.update({
          closedAt: Date.now(),
          outcome,
          lastCompletedStep: outcome === 'completed' ? 4 : -1,
          checklist: {
            ...checklist,
            dismissed: outcome === 'dismissed'
          }
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
      onOnboardingChange(nextState)
      if (outcome === 'completed' && completedPath) {
        const total = Math.max(0, Date.now() - startTimeRef.current)
        track('onboarding_completed', {
          path: completedPath,
          is_git_repo: checklist.addedRepo === true,
          total_duration_ms: total
        })
        // Why: checklist items completed by the wizard itself must fire
        // `activation_checklist_item_completed` so the post-wizard panel and
        // analytics agree. Other items (ranFirstAgent, triedCmdJ, …) emit
        // from their own product surfaces.
        if (checklist.addedRepo && !onboarding.checklist.addedRepo) {
          track('activation_checklist_item_completed', {
            item: 'addedRepo',
            time_since_completed_ms: 0
          })
        }
        if (checklist.addedFolder && !onboarding.checklist.addedFolder) {
          track('activation_checklist_item_completed', {
            item: 'addedFolder',
            time_since_completed_ms: 0
          })
        }
      } else if (outcome === 'dismissed') {
        track('onboarding_dismissed', { last_step: lastStepReached })
      }
      return true
    },
    [onOnboardingChange, onboarding.checklist]
  )

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
      if (!closed) return
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

  const persistCurrentStep = useCallback(async (): Promise<boolean> => {
    if (!settings) {
      return false
    }
    try {
      if (currentStep.id === 'agent') {
        const defaultTuiAgent = selectedAgentOrBlank(selectedAgent)
        await updateSettings({ defaultTuiAgent })
        const choseAgent = defaultTuiAgent !== 'blank'
        const wasAlreadyChosen = onboarding.checklist.choseAgent
        onOnboardingChange(
          await persistStep(1, {
            checklist: { ...onboarding.checklist, choseAgent }
          })
        )
        if (choseAgent && !wasAlreadyChosen) {
          track('activation_checklist_item_completed', {
            item: 'choseAgent',
            time_since_completed_ms: 0
          })
        }
        return true
      }
      if (currentStep.id === 'theme') {
        await updateSettings({ theme })
        onOnboardingChange(await persistStep(2))
        return true
      }
      if (currentStep.id === 'notifications') {
        const enabled = notifications.agentTaskComplete || notifications.terminalBell
        if (enabled) {
          // Why: triggers macOS first-prompt notification on first call. Only fire
          // on Continue; Skip uses the persistence-only path below.
          await window.api.notifications.requestPermission()
        }
        await updateSettings({
          notifications: {
            ...settings.notifications,
            enabled,
            agentTaskComplete: notifications.agentTaskComplete,
            terminalBell: notifications.terminalBell,
            // Why: invert positive UX framing back to persisted negative field.
            suppressWhenFocused: !notifications.notifyWhenFocused
          }
        })
        onOnboardingChange(await persistStep(3))
        return true
      }
      return false
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [
    currentStep.id,
    notifications,
    onboarding.checklist,
    onOnboardingChange,
    selectedAgent,
    settings,
    theme,
    updateSettings
  ])

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
  }, [completeRepo])

  const clone = useCallback(async () => {
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
  }, [cloneUrl, completeRepo, settings])

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
    setSelectedAgent,
    theme,
    setTheme,
    notifications,
    setNotifications,
    cloneUrl,
    setCloneUrl,
    busyLabel,
    error,
    detectedSet,
    next,
    skip,
    back,
    openFolder,
    clone
  }
}
