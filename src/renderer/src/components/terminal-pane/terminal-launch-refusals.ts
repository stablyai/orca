import { isClaudeAccountLaunchRefusal } from '../../../../shared/claude-account-refusal-copy'

// Why: a launch the host refused with a reason already explains itself in the pane, so a
// generic "the terminal did not start" toast on top of it reads like a crash.
const refusedTabIds = new Set<string>()
const MAX_TRACKED = 50

export function noteTerminalLaunchError(tabId: string, message: string): void {
  if (!isClaudeAccountLaunchRefusal(message)) {
    return
  }
  refusedTabIds.add(tabId)
  if (refusedTabIds.size > MAX_TRACKED) {
    refusedTabIds.delete(refusedTabIds.values().next().value ?? tabId)
  }
}

/** True once per tab whose launch the host refused with an explanation. */
export function consumeExplainedLaunchRefusal(tabId: string): boolean {
  return refusedTabIds.delete(tabId)
}
