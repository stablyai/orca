import { useCallback } from 'react'
import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { ONBOARDING_FINAL_STEP } from '../../../../shared/constants'
import type { GlobalSettings, OnboardingState, TuiAgent } from '../../../../shared/types'
import type { NotificationDraft } from './NotificationStep'
import {
  hasSelectedOnboardingFeatureSetup,
  onboardingFeatureSetupRunTelemetry,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupResult,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'
import type { StepId, StepNumber } from './use-onboarding-flow-types'

export async function persistStep(
  stepNumber: number,
  updates: Partial<OnboardingState> = {}
): Promise<OnboardingState> {
  return window.api.onboarding.update({
    lastCompletedStep: Math.max(stepNumber, -1),
    ...updates
  })
}

function selectedAgentOrBlank(agent: TuiAgent | null): TuiAgent | 'blank' {
  return agent ?? 'blank'
}

type CloseWithDeps = {
  onOnboardingChange: (state: OnboardingState) => void
  onboardingChecklist: OnboardingState['checklist']
  startTimeRef: { current: number }
  setError: (msg: string | null) => void
}

export type DismissedExtras = {
  advancedVia: 'button' | 'keyboard'
  durationMs: number
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
      completedPath?: 'open_folder' | 'clone_url',
      dismissedExtras?: DismissedExtras
    ): Promise<boolean> => {
      let nextState: OnboardingState
      try {
        // Why: main-process updateOnboarding already merges with current state,
        // so spreading the local (potentially stale) onboarding.checklist would
        // overwrite concurrent updates.
        nextState = await window.api.onboarding.update({
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
        track('onboarding_completed', {
          path: completedPath,
          is_git_repo: checklist.addedRepo === true,
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
      } else if (outcome === 'dismissed') {
        track('onboarding_dismissed', {
          last_step: lastStepReached,
          ...(dismissedExtras
            ? {
                duration_ms: dismissedExtras.durationMs,
                advanced_via: dismissedExtras.advancedVia
              }
            : {})
        })
      }
      return true
    },
    [onOnboardingChange, onboardingChecklist, startTimeRef, setError]
  )
}

type PersistCurrentStepDeps = {
  currentStepId: StepId
  selectedAgent: TuiAgent | null
  theme: GlobalSettings['theme']
  notifications: NotificationDraft
  featureSetupSelection: OnboardingFeatureSetupSelection
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  onboardingChecklist: OnboardingState['checklist']
  onOnboardingChange: (state: OnboardingState) => void
  setError: (msg: string | null) => void
}

export type PersistCurrentStepResult = {
  ok: boolean
  featureSetupResult?: OnboardingFeatureSetupResult
}

export function usePersistCurrentStep({
  currentStepId,
  selectedAgent,
  theme,
  notifications,
  featureSetupSelection,
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
        await updateSettings({ defaultTuiAgent })
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
        const setupResult = await runOnboardingFeatureSetup(featureSetupSelection)
        const featureSetupResult: OnboardingFeatureSetupResult = setupResult
        track('onboarding_feature_setup_run', {
          ...onboardingFeatureSetupRunTelemetry(featureSetupSelection, setupResult)
        })
        if (hasSelectedOnboardingFeatureSetup(featureSetupSelection)) {
          const firstWarning = setupResult.warnings[0]
          if (firstWarning) {
            toast.warning('Some feature setup needs attention', {
              description: firstWarning.message
            })
          }
          if (setupResult.skillCommandsCopied) {
            toast.success('Feature setup ready', {
              description: 'Skill command copied and inserted below for review.'
            })
          }
          if (setupResult.computerUsePermissionsOpened) {
            toast.message('Opened Computer Use permissions')
          }
        }
        onOnboardingChange(await persistStep(3))
        return { ok: true, featureSetupResult }
      }
      return { ok: false }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return { ok: false }
    }
  }, [
    currentStepId,
    featureSetupSelection,
    notifications,
    onboardingChecklist,
    onOnboardingChange,
    selectedAgent,
    settings,
    theme,
    updateSettings,
    setError
  ])
}
