import type { ClaudeAutoSwitchedEvent } from '../../../shared/managed-account-types'
import { handleRunningClaudeSessionsAfterSwitch } from './claude-account-switch-sessions'

/** Treats running Claude sessions after an automatic switch the way a switch by hand does. */
export async function followClaudeAutoSwitch(event: ClaudeAutoSwitchedEvent): Promise<void> {
  const {
    accounts,
    systemDefaultHome,
    systemDefaultEmail,
    systemDefaultOrganizationUuid,
    paneAssignments
  } = event
  const state = {
    accounts,
    systemDefaultHome,
    systemDefaultEmail,
    systemDefaultOrganizationUuid,
    paneAssignments
  }
  await handleRunningClaudeSessionsAfterSwitch({
    owner: { kind: 'local' },
    target: event.target,
    before: { state, accountId: event.fromAccountId },
    after: { state, accountId: event.toAccountId }
  })
}
