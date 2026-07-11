import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  LINEAR_AGENT_SKILL_SETUP_TOAST_LIMIT,
  createLinearAgentSkillSetupActivationId,
  getExistingLinearAgentSkillSetupReminderState,
  getLinearAgentSkillSetupReminderState,
  resetLinearAgentSkillSetupReminderState
} from './linear-agent-skill-setup-reminders'
import { translate } from '@/i18n/i18n'

type UseLinearAgentSkillSetupReminderToastInput = {
  localDismissStorageKey: string
  missingSetup: boolean
  setupDialogOpen: boolean
  surface: 'inline' | 'modal'
  toastDescription: string
  toastTitle: string
  openSetupDialog: () => void
}

export function resetLinearAgentSkillSetupReminderToastState(): void {
  resetLinearAgentSkillSetupReminderState()
}

export function snoozeLinearAgentSkillSetupReminderToast(localDismissStorageKey: string): void {
  getLinearAgentSkillSetupReminderState(localDismissStorageKey).snoozed = true
}

export function dismissLinearAgentSkillSetupReminderToast(localDismissStorageKey: string): void {
  const state = getExistingLinearAgentSkillSetupReminderState(localDismissStorageKey)
  // Why: the state may already be evicted, but the deterministic id still lets
  // cleanup dismiss a visible toast without recreating a cache entry.
  toast.dismiss(getLinearAgentSkillSetupReminderToastId(localDismissStorageKey))
  if (state) {
    state.activeToastId = undefined
  }
}

function getLinearAgentSkillSetupReminderToastId(localDismissStorageKey: string): string {
  return `linear-agent-skill-setup-${localDismissStorageKey}`
}

export function resetLinearAgentSkillSetupReminderToastForRuntime(
  localDismissStorageKey: string
): void {
  const state = getExistingLinearAgentSkillSetupReminderState(localDismissStorageKey)
  if (state) {
    state.modalShown = false
    state.snoozed = false
    state.toastCount = 0
    state.lastToastActivationId = undefined
  }
  dismissLinearAgentSkillSetupReminderToast(localDismissStorageKey)
}

export function useLinearAgentSkillSetupReminderToast({
  localDismissStorageKey,
  missingSetup,
  setupDialogOpen,
  surface,
  toastDescription,
  toastTitle,
  openSetupDialog
}: UseLinearAgentSkillSetupReminderToastInput): void {
  const activationIdRef = useRef<string | undefined>(undefined)
  if (activationIdRef.current === undefined) {
    activationIdRef.current = createLinearAgentSkillSetupActivationId()
  }

  useEffect(() => {
    if (surface !== 'modal' || !missingSetup) {
      return
    }
    const state = getLinearAgentSkillSetupReminderState(localDismissStorageKey)
    if (!state.modalShown) {
      // Why: first eligible Linear activation gets the full setup flow; casual
      // closes only change later activations for the same runtime target.
      state.modalShown = true
      state.lastToastActivationId = activationIdRef.current
      openSetupDialog()
    }
  }, [localDismissStorageKey, missingSetup, openSetupDialog, surface])

  useEffect(() => {
    if (surface !== 'modal' || !missingSetup || setupDialogOpen) {
      return
    }
    const state = getLinearAgentSkillSetupReminderState(localDismissStorageKey)
    const activationId = activationIdRef.current
    if (
      !state.modalShown ||
      !state.snoozed ||
      state.toastCount >= LINEAR_AGENT_SKILL_SETUP_TOAST_LIMIT ||
      state.lastToastActivationId === activationId
    ) {
      return
    }
    state.toastCount += 1
    state.lastToastActivationId = activationId
    const toastId = getLinearAgentSkillSetupReminderToastId(localDismissStorageKey)
    const clearActiveToast = (): void => {
      const currentState = getExistingLinearAgentSkillSetupReminderState(localDismissStorageKey)
      if (currentState?.activeToastId === toastId) {
        currentState.activeToastId = undefined
      }
    }
    const openSetupFromToast = (): void => {
      toast.dismiss(toastId)
      clearActiveToast()
      openSetupDialog()
    }
    state.activeToastId = toastId
    toast.warning(toastTitle, {
      id: toastId,
      description: toastDescription,
      onDismiss: clearActiveToast,
      onAutoClose: clearActiveToast,
      action: {
        label: translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.setup', 'Set up'),
        onClick: openSetupFromToast
      }
    })
  }, [
    localDismissStorageKey,
    missingSetup,
    openSetupDialog,
    setupDialogOpen,
    surface,
    toastDescription,
    toastTitle
  ])

  useEffect(() => {
    if (!missingSetup) {
      dismissLinearAgentSkillSetupReminderToast(localDismissStorageKey)
    }
  }, [localDismissStorageKey, missingSetup])

  useEffect(
    () => {
      if (surface !== 'modal') {
        return
      }
      return () => {
        dismissLinearAgentSkillSetupReminderToast(localDismissStorageKey)
      }
    },
    [localDismissStorageKey, surface]
  )
}
