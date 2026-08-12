export const LINEAR_AGENT_SKILL_SETUP_TOAST_LIMIT = 3
export const MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS = 256

type LinearAgentSkillSetupReminderState = {
  modalShown: boolean
  toastCount: number
  snoozed: boolean
  lastToastActivationId?: string
  activeToastId?: string
}

const reminderStateByRuntimeKey = new Map<string, LinearAgentSkillSetupReminderState>()
let nextActivationId = 0

function evictLinearAgentSkillSetupReminderStateIfAtCapacity(): void {
  if (reminderStateByRuntimeKey.size < MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS) {
    return
  }
  let evictionKey = reminderStateByRuntimeKey.keys().next().value
  // Why: visible toasts retain their reminder state when an inactive entry can
  // be evicted instead; deterministic toast ids still make fallback cleanup safe.
  for (const [runtimeKey, state] of reminderStateByRuntimeKey) {
    if (state.activeToastId === undefined) {
      evictionKey = runtimeKey
      break
    }
  }
  if (evictionKey !== undefined) {
    reminderStateByRuntimeKey.delete(evictionKey)
  }
}

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
    reminderStateByRuntimeKey.delete(localDismissStorageKey)
    reminderStateByRuntimeKey.set(localDismissStorageKey, existing)
    return existing
  }
  const nextState: LinearAgentSkillSetupReminderState = {
    modalShown: false,
    toastCount: 0,
    snoozed: false
  }
  // Why: runtime dismiss keys can churn as local/remote targets change; keep
  // recent reminder UX state without retaining stale runtime keys forever.
  evictLinearAgentSkillSetupReminderStateIfAtCapacity()
  reminderStateByRuntimeKey.set(localDismissStorageKey, nextState)
  return nextState
}

export function getExistingLinearAgentSkillSetupReminderState(
  localDismissStorageKey: string
): LinearAgentSkillSetupReminderState | undefined {
  return reminderStateByRuntimeKey.get(localDismissStorageKey)
}

export function resetLinearAgentSkillSetupReminderState(): void {
  reminderStateByRuntimeKey.clear()
  nextActivationId = 0
}

export function getLinearAgentSkillSetupReminderStateCountForTests(): number {
  return reminderStateByRuntimeKey.size
}

export function hasLinearAgentSkillSetupReminderStateForTests(
  localDismissStorageKey: string
): boolean {
  return reminderStateByRuntimeKey.has(localDismissStorageKey)
}
