import { isLegacyAgentSessionAccountHome } from '../../agent-session/lifecycle/accounts/agent-session-account-home'
import type { AiVaultSession } from '../contracts/ai-vault-types'

/** Undefined lists every account; null lists System default; an id lists that saved account. */
export type AiVaultClaudeAccountFilter = string | null | undefined

// An Orca account folder is <dataRoot>/claude-profiles/<accountId>/home.
const ACCOUNT_HOME = /[\\/]claude-profiles[\\/]([A-Za-z0-9_-]+)[\\/]home[\\/]?$/

/** The saved account a Claude session ran on: null for System default, undefined when unknown
 *  (another agent, or a terminal session in shared history). */
export function aiVaultSessionClaudeAccountId(
  session: Pick<AiVaultSession, 'agent' | 'accountHome'>
): string | null | undefined {
  const home = session.accountHome
  if (session.agent !== 'claude' || home === undefined) {
    return undefined
  }
  if (home === null || !isLegacyAgentSessionAccountHome(home)) {
    return null
  }
  return ACCOUNT_HOME.exec(home.path)?.[1] ?? null
}

export function matchesAiVaultClaudeAccountFilter(
  session: Pick<AiVaultSession, 'agent' | 'accountHome'>,
  filter: AiVaultClaudeAccountFilter
): boolean {
  return filter === undefined || aiVaultSessionClaudeAccountId(session) === filter
}
