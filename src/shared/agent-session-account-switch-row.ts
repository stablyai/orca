// The quiet row a chat gets when it moves to the account selected in Orca's picker.

import type { AgentJournalPlainStatusItem } from './agent-session-journal-types'

export const AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION = 'account-switched'

/** The account the chat now runs on: its sign-in email, or absent for System default. */
export type AgentSessionAccountSwitch = { account?: string }

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

export function readAgentSessionAccountSwitch(
  value: unknown
): AgentSessionAccountSwitch | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const account = 'account' in value ? value.account : undefined
  return typeof account === 'string' && account.length > 0 ? { account } : {}
}
