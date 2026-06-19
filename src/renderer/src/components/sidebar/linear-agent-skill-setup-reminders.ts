export const LINEAR_AGENT_SKILL_SETUP_TOAST_LIMIT = 3

type LinearAgentSkillSetupReminderState = {
  modalShown: boolean
  toastCount: number
  snoozed: boolean
  lastToastActivationId?: string
  activeToastId?: string | number
}

const reminderStateByRuntimeKey = new Map<string, LinearAgentSkillSetupReminderState>()
let nextActivationId = 0

export function createLinearAgentSkillSetupActivationId(): string {
  const activationId = `linear-agent-skill-setup-${nextActivationId}`
  nextActivationId += 1
  return activationId
}

export function getLinearAgentSkillSetupReminderState(
  localDismissStorageKey: string
): LinearAgentSkillSetupReminderState {
  const existing = reminderStateByRuntimeKey.get(localDismissStorageKey)
  if (existing) {
    return existing
  }
  const nextState: LinearAgentSkillSetupReminderState = {
    modalShown: false,
    toastCount: 0,
    snoozed: false
  }
  reminderStateByRuntimeKey.set(localDismissStorageKey, nextState)
  return nextState
}

export function resetLinearAgentSkillSetupReminderState(): void {
  reminderStateByRuntimeKey.clear()
  nextActivationId = 0
}
