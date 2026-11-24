import { useAppStore } from '@/store/index'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import type { ClaudeHostSelectionChange } from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'
import { collectTerminalProviderSnapshotPtyIds } from '@/components/terminal/provider-snapshots/terminal-provider-snapshot-capability'

/** This computer's host moves the running Claude terminals no tab here names (the window restarts
 *  those), such as a background agent launch in a workspace this window never opened. */
export function moveUnheldClaudeSessions(
  change: ClaudeHostSelectionChange
): Promise<ClaudeHostRunningSessionsMove | undefined> {
  const move = window.api.claudeAccounts?.moveUnheldRunningSessions
  if (!move) {
    return Promise.resolve(undefined)
  }
  return move({
    change,
    heldPtyIds: collectTerminalProviderSnapshotPtyIds(useAppStore.getState())
  }).catch((error: unknown) => {
    console.warn(
      '[claude-account-switch] could not move terminals this window does not hold:',
      error
    )
    return undefined
  })
}
