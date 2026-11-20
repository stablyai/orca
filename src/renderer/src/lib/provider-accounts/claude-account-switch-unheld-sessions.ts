import { useAppStore } from '@/store/index'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import type { ClaudeHostSelectionChange } from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'

/** Every terminal a pane in this window is bound to: the window restarts those itself. */
function windowHeldPtyIds(): string[] {
  const state = useAppStore.getState()
  const held = new Set<string>()
  for (const ptyIds of Object.values(state.ptyIdsByTabId)) {
    for (const ptyId of ptyIds ?? []) {
      held.add(ptyId)
    }
  }
  for (const layout of Object.values(state.terminalLayoutsByTabId)) {
    for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      if (ptyId) {
        held.add(ptyId)
      }
    }
  }
  return [...held]
}

/** This computer's host moves the running Claude terminals no pane here is bound to, such as a
 *  background agent launch in a workspace this window never opened. */
export function moveUnheldClaudeSessions(
  change: ClaudeHostSelectionChange
): Promise<ClaudeHostRunningSessionsMove | undefined> {
  const move = window.api.claudeAccounts?.moveUnheldRunningSessions
  if (!move) {
    return Promise.resolve(undefined)
  }
  return move({ change, heldPtyIds: windowHeldPtyIds() }).catch((error: unknown) => {
    console.warn(
      '[claude-account-switch] could not move terminals this window does not hold:',
      error
    )
    return undefined
  })
}
