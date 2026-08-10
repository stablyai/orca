type SleepingAgentWakeIntentOwner = {
  deferActivation: (worktreeId: string) => boolean
}

let activeOwner: SleepingAgentWakeIntentOwner | null = null

export function installSleepingAgentWakeIntentOwner(
  owner: SleepingAgentWakeIntentOwner
): () => void {
  activeOwner = owner
  return () => {
    if (activeOwner === owner) {
      activeOwner = null
    }
  }
}

export function deferSleepingAgentActivationWake(worktreeId: string): boolean {
  return activeOwner?.deferActivation(worktreeId) ?? true
}
