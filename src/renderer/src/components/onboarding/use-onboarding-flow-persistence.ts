import { useCallback, useRef } from 'react'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import {
  ONBOARDING_FINAL_STEP,
  ONBOARDING_FLOW_VERSION
} from '../../../../shared/onboarding-defaults'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { applyAllAgentsPermission } from '../../../../shared/tui-agent-permission-choice'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
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

/** Apply Yolo to chat defaults only after an explicit toggle; preserve custom modes as with agent arguments. */
export function onboardingChatPermissionSetting(
  current: AgentChatPermissionMode | undefined,
  yolo: boolean,
  chosen: boolean
): Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>> {
  return !chosen || current === 'accept-edits' || current === 'auto'
    ? {}
    : { nativeChatPermissionMode: yolo ? 'full-access' : 'ask' }
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

export function useCloseWith({ onOnboardingChange, startTimeRef, setError }: CloseWithDeps) {
  // First close wins across completion/dismissal during persistence, preventing duplicate writes and telemetry.
  const closedRef = useRef(false)
  return useCallback(
    async (
      outcome: 'completed' | 'dismissed',
      lastStepReached: StepNumber,
      completedPath?: 'add_project_modal',
      dismissedExtras?: DismissedExtras
    ): Promise<boolean> => {
      if (closedRef.current) {
        return false
      }
      closedRef.current = true
      let nextState: OnboardingState
      try {
        nextState = await window.api.onboarding.update({
          flowVersion: ONBOARDING_FLOW_VERSION,
          closedAt: Date.now(),
          outcome,
          lastCompletedStep: outcome === 'completed' ? ONBOARDING_FINAL_STEP : -1,
          checklist: { dismissed: outcome === 'dismissed' }
        })
      } catch (err) {
        // A failed write did not close onboarding; release the latch for retry.
        closedRef.current = false
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
      onOnboardingChange(nextState)
      if (outcome === 'completed' && completedPath) {
        const total = Math.max(0, Date.now() - startTimeRef.current)
        // Project selection happens later; repo_added owns is_git_repo telemetry.
        track('onboarding_completed', {
          path: completedPath,
          total_duration_ms: total
        })
      }
      if (outcome === 'completed') {
        // Wait until the next commit can unmount onboarding before notifying star nag.
        window.setTimeout(() => {
          void window.api.starNag.onboardingCompleted()
        }, 0)
      } else if (outcome === 'dismissed') {
        trackOnboardingDismissed(lastStepReached, dismissedExtras)
      }
      return true
    },
    [onOnboardingChange, startTimeRef, setError]
  )
}

type PersistCurrentStepDeps = {
  currentStepId: StepId
  selectedAgent: TuiAgent | null
  yoloPermissions: boolean
  /** Whether the person flipped Yolo mode in this flow; a replay left untouched keeps chats as set. */
  yoloPermissionsChosen: { readonly current: boolean }
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
  yoloPermissionsChosen,
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
          // Off adds no flag, as it always has: each agent's own settings apply.
          ...(yoloPermissionsChosen.current
            ? applyAllAgentsPermission(settings, yoloPermissions ? 'full-access' : 'own')
            : {}),
          ...onboardingChatPermissionSetting(
            settings.nativeChatPermissionMode,
            yoloPermissions,
            yoloPermissionsChosen.current
          )
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
        // Selections already persist; Continue only records page completion for resume/telemetry.
        onOnboardingChange(await persistStep(4))
        return { ok: true }
      }
      if (currentStepId === 'integrations') {
        // Connections persist in their integration slices; this step only records completion.
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
    yoloPermissionsChosen,
    setError
  ])
}
