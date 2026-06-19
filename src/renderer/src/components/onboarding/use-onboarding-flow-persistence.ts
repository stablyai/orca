import { useCallback } from 'react'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../../shared/constants'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { GlobalSettings, OnboardingState, TuiAgent } from '../../../../shared/types'
import { applyAgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { StepId, StepNumber } from './use-onboarding-flow-types'

export async function persistStep(
  stepNumber: number,
  updates: Partial<OnboardingState> = {}
): Promise<OnboardingState> {
  return window.api.onboarding.update({
    flowVersion: ONBOARDING_FLOW_VERSION,
    lastCompletedStep: Math.max(stepNumber, -1),
    ...updates
  })
}

function selectedAgentOrBlank(agent: TuiAgent | null): TuiAgent | 'blank' {
  return agent ?? 'blank'
}

export function buildCompletedOnboardingNotificationSettings(
  notifications: GlobalSettings['notifications']
): GlobalSettings['notifications'] {
  return {
    ...notifications,
    enabled: true,
    agentTaskComplete: true,
    terminalBell: true
  }
}

type CloseWithDeps = {
  onOnboardingChange: (state: OnboardingState) => void
  onboardingChecklist: OnboardingState['checklist']
  startTimeRef: { current: number }
  setError: (msg: string | null) => void
}

export type DismissedExtras = {
  advancedVia: NonNullable<EventProps<'onboarding_dismissed'>['advanced_via']>
  durationMs: number
}

export function buildOnboardingDismissedPayload(
  lastStepReached: StepNumber,
  dismissedExtras?: DismissedExtras
): EventProps<'onboarding_dismissed'> {
  return {
    last_step: lastStepReached,
    ...(dismissedExtras
      ? {
          duration_ms: dismissedExtras.durationMs,
          advanced_via: dismissedExtras.advancedVia
        }
      : {})
  }
}

export function trackOnboardingDismissed(
  lastStepReached: StepNumber,
  dismissedExtras?: DismissedExtras
): void {
  track('onboarding_dismissed', buildOnboardingDismissedPayload(lastStepReached, dismissedExtras))
}

export function useCloseWith({
  onOnboardingChange,
  onboardingChecklist,
  startTimeRef,
  setError
}: CloseWithDeps) {
  return useCallback(
    async (
      outcome: 'completed' | 'dismissed',
      checklist: Partial<OnboardingState['checklist']>,
      lastStepReached: StepNumber,
      completedPath?: 'open_folder' | 'clone_url' | 'add_project_modal',
      dismissedExtras?: DismissedExtras
    ): Promise<boolean> => {
      let nextState: OnboardingState
      try {
        // Why: main-process updateOnboarding already merges with current state,
        // so spreading the local (potentially stale) onboarding.checklist would
        // overwrite concurrent updates.
        nextState = await window.api.onboarding.update({
          flowVersion: ONBOARDING_FLOW_VERSION,
          closedAt: Date.now(),
          outcome,
          lastCompletedStep: outcome === 'completed' ? ONBOARDING_FINAL_STEP : -1,
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
        // Why: no `is_git_repo` — project selection now happens in the Add
        // Project modal after this fires, so the signal moved to
        // `repo_added.is_git_repo`. See docs/reference/telemetry-availability.md.
        track('onboarding_completed', {
          path: completedPath,
          total_duration_ms: total
        })
        // Why: checklist items completed by the wizard itself must fire
        // `activation_checklist_item_completed` so the post-wizard panel and
        // analytics agree. Other items (ranFirstAgent, triedCmdJ, …) emit
        // from their own product surfaces.
        if (checklist.addedRepo && !onboardingChecklist.addedRepo) {
          track('activation_checklist_item_completed', {
            item: 'addedRepo',
            time_since_completed_ms: 0
          })
        }
        if (checklist.addedFolder && !onboardingChecklist.addedFolder) {
          track('activation_checklist_item_completed', {
            item: 'addedFolder',
            time_since_completed_ms: 0
          })
        }
      }
      if (outcome === 'completed') {
        // Why: closeWith updates parent state synchronously from this hook's
        // perspective, but the modal unmounts on the next React commit.
        window.setTimeout(() => {
          void window.api.starNag.onboardingCompleted()
        }, 0)
      } else if (outcome === 'dismissed') {
        trackOnboardingDismissed(lastStepReached, dismissedExtras)
      }
      return true
    },
    [onOnboardingChange, onboardingChecklist, startTimeRef, setError]
  )
}

type PersistCurrentStepDeps = {
  currentStepId: StepId
  selectedAgent: TuiAgent | null
  yoloPermissions: boolean
  theme: GlobalSettings['theme']
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  onboardingChecklist: OnboardingState['checklist']
  onOnboardingChange: (state: OnboardingState) => void
  setError: (msg: string | null) => void
}

export type PersistCurrentStepResult = {
  ok: boolean
}

export function usePersistCurrentStep({
  currentStepId,
  selectedAgent,
  yoloPermissions,
  theme,
  settings,
  updateSettings,
  onboardingChecklist,
  onOnboardingChange,
  setError
}: PersistCurrentStepDeps) {
  return useCallback(async (): Promise<PersistCurrentStepResult> => {
    if (!settings) {
      return { ok: false }
    }
    try {
      if (currentStepId === 'agent') {
        const defaultTuiAgent = selectedAgentOrBlank(selectedAgent)
        await updateSettings({
          defaultTuiAgent,
          ...applyAgentPermissionMode({
            mode: yoloPermissions ? 'yolo' : 'manual',
            agentDefaultArgs: settings.agentDefaultArgs,
            agentDefaultEnv: settings.agentDefaultEnv
          })
        })
        const choseAgent = defaultTuiAgent !== 'blank'
        const wasAlreadyChosen = onboardingChecklist.choseAgent
        onOnboardingChange(
          await persistStep(1, {
            checklist: { ...onboardingChecklist, choseAgent }
          })
        )
        if (choseAgent && !wasAlreadyChosen) {
          track('activation_checklist_item_completed', {
            item: 'choseAgent',
            time_since_completed_ms: 0
          })
        }
        return { ok: true }
      }
      if (currentStepId === 'theme') {
        await updateSettings({ theme })
        onOnboardingChange(await persistStep(2))
        return { ok: true }
      }
      if (currentStepId === 'notifications') {
        await updateSettings({
          notifications: buildCompletedOnboardingNotificationSettings(settings.notifications)
        })
        useAppStore.getState().recordFeatureInteraction('notifications')
        onOnboardingChange(await persistStep(ONBOARDING_FINAL_STEP))
        return { ok: true }
      }
      if (currentStepId === 'windows_terminal') {
        // Why: the Windows terminal controls persist on selection. Continuing
        // only marks the preference page complete for resume/telemetry state.
        onOnboardingChange(await persistStep(4))
        return { ok: true }
      }
      if (currentStepId === 'integrations') {
        // Why: GitHub and Linear connections persist through their own
        // store slices when the user actually wires them up. The step itself
        // is a no-op for settings/onboarding state beyond marking it
        // completed.
        onOnboardingChange(await persistStep(3))
        return { ok: true }
      }
      return { ok: false }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return { ok: false }
    }
  }, [
    currentStepId,
    onboardingChecklist,
    onOnboardingChange,
    selectedAgent,
    settings,
    theme,
    updateSettings,
    yoloPermissions,
    setError
  ])
}
