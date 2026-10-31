// The quiet row a chat gets when it moves to the account selected in Orca's picker, or cannot.

import type { AgentJournalPlainStatusItem } from './agent-session-journal-types'

export const AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION = 'account-switched'

export const AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION = 'account-switch-failed'

/** The account the chat now runs on (or could not move to): its sign-in email, or absent for
 *  System default. `from`, on a failed move, is where it stayed: an email, null for System
 *  default, absent when unknown. */
export type AgentSessionAccountSwitch = { account?: string; from?: string | null }

export function agentSessionAccountSwitchText(account: string | undefined): string {
  return `Now on ${account ?? 'System default'} · same conversation`
}

export function agentSessionAccountSwitchBody(
  account: string | undefined
): AgentJournalPlainStatusItem {
  return {
    kind: 'status',
    // Clients that predate the presentation print this sentence.
    text: agentSessionAccountSwitchText(account),
    presentation: AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION,
    accountSwitch: account === undefined ? {} : { account }
  }
}

function accountSwitchFailedText(switched: AgentSessionAccountSwitch): string {
  const to = switched.account ?? 'System default'
  return switched.from === undefined
    ? `Couldn't move this chat to ${to}; it stays on its current account`
    : `Couldn't move this chat to ${to}; it's still on ${switched.from ?? 'System default'}`
}

export function agentSessionAccountSwitchFailedBody(
  switched: AgentSessionAccountSwitch
): AgentJournalPlainStatusItem {
  return {
    kind: 'status',
    text: accountSwitchFailedText(switched),
    presentation: AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION,
    accountSwitch: switched
  }
}

export function readAgentSessionAccountSwitch(
  value: unknown
): AgentSessionAccountSwitch | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const account = 'account' in value ? value.account : undefined
  const from = 'from' in value ? value.from : undefined
  return {
    ...(typeof account === 'string' && account.length > 0 ? { account } : {}),
    ...(from === null || (typeof from === 'string' && from.length > 0) ? { from } : {})
  }
}
