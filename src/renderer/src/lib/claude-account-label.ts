import type { AgentAccountSnapshot } from './agent-account-switch-agent'

/** Display label for a selected Claude account row; null is System default. */
export function getClaudeAccountLabel(
  state: AgentAccountSnapshot['state'],
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Claude account'
}
