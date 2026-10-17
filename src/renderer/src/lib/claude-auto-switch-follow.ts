import type { ClaudeAutoSwitchedEvent } from '../../../shared/managed-account-types'
import { handleRunningClaudeSessionsAfterSwitch } from './claude-account-switch-sessions'

/** Treats running Claude sessions after an automatic switch the way a switch by hand does. */
export async function followClaudeAutoSwitch(event: ClaudeAutoSwitchedEvent): Promise<void> {
  const state = { accounts: event.accounts }
  await handleRunningClaudeSessionsAfterSwitch({
    owner: { kind: 'local' },
    target: event.target,
    before: { state, accountId: event.fromAccountId },
    after: { state, accountId: event.toAccountId }
  })
}
