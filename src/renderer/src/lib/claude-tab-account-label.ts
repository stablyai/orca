import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { isPinnableClaudeAccountId } from '../../../shared/claude/project-claude-account-preference'
import type { ClaudeManagedAccountSummary } from '../../../shared/managed-account-types'

export type ClaudeTabAccountSource = {
  /** Main's pinned-PTY record, stamped on the pane's agent-status row; survives restarts. */
  statusAccountId: string | undefined
  /** This renderer's launch record; only a fast path until main's row arrives, empty after a restart. */
  launchConfig: SleepingAgentLaunchConfig | undefined
}

/** Email of the account a pinned Claude tab runs on, or null when the tab shows no label. */
export function claudeTabAccountLabel(
  source: ClaudeTabAccountSource,
  accounts: ClaudeManagedAccountSummary[],
  { pinningUnsupported }: { pinningUnsupported: boolean }
): string | null {
  // Why: SSH and WSL launches may carry a claudeAccountId but never actually pin it.
  if (pinningUnsupported) {
    return null
  }
  const accountId = source.statusAccountId ?? source.launchConfig?.claudeAccountId
  if (!isPinnableClaudeAccountId(accountId)) {
    return null
  }
  return accounts.find((account) => account.id === accountId)?.email ?? null
}
