// Private layer, Orca Cloud only: a cloud Claude/Codex pane whose agent isn't signed in sits at its
// own "Not logged in" screen, yet its row would read "Done". The row says why instead. The source of
// truth is the Orca account's Agent accounts (credential state and providerState, via the shared
// coverage selector), combined with "no turn finished"; the sandbox's own sign-in report can
// clear it (signedIn) or add to it (signedOut).
import type { AgentDotState } from '@/components/AgentStateDot'
import type { Translate } from '@/i18n/use-translate'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent,
  type HostAgentSignInEntry
} from '../../../../shared/host-agent-sign-in-status'
import {
  orcaCloudAgentCoverageFromAccounts,
  type OrcaCloudAgentAccountsRead
} from './orca-cloud-agent-accounts-model'

export type CloudAgentRowSignIn = 'needsSignIn' | 'expired'

export function cloudRowSignInAgent(agentType: string): HostAgentSignInAgent | null {
  return HOST_AGENT_SIGN_IN_AGENTS.find((agent) => agent === agentType) ?? null
}

/** The turn evidence on a row: what only a turn that ran and ended leaves behind. */
export type CloudRowTurnEvidence = Pick<
  AgentStatusEntry,
  'lastAssistantMessage' | 'stateHistory' | 'turnEndedAt'
>

/**
 * True when no turn has finished: no state history, no turn end and no assistant reply. Hook
 * markers such as sessionBoundary are not used: a row mirrored from a cloud host can lack them.
 */
export function hasNoFinishedTurn(entry: CloudRowTurnEvidence): boolean {
  return (
    (entry.stateHistory?.length ?? 0) === 0 &&
    entry.turnEndedAt === undefined &&
    !entry.lastAssistantMessage?.trim()
  )
}

/**
 * Only a row that has not finished a turn can be waiting on sign-in: a finished turn proves the
 * agent reached its provider, so its Done stays.
 */
export function isCloudRowSignInCandidate(row: {
  agentType: string
  dotState: AgentDotState
  entry: CloudRowTurnEvidence
  isChildRow: boolean
}): boolean {
  return (
    !row.isChildRow &&
    (row.dotState === 'done' || row.dotState === 'idle') &&
    cloudRowSignInAgent(row.agentType) !== null &&
    hasNoFinishedTurn(row.entry)
  )
}

/**
 * Agent accounts decide: not set up -> needsSignIn, expired or revoked -> expired. A sandbox that
 * reports the agent signedIn (an account placeholder, a key, or a /login there) clears the row;
 * one that reports signedOut needs sign-in too. A paused or never-offered provider, or a read
 * not ready yet, shows nothing; the row updates when the read lands.
 */
export function cloudAgentRowSignIn(
  agent: HostAgentSignInAgent,
  accounts: OrcaCloudAgentAccountsRead,
  hostEntry: HostAgentSignInEntry | null
): CloudAgentRowSignIn | null {
  if (hostEntry?.state === 'signedIn' || hostEntry?.state === 'notInstalled') {
    return null
  }
  const coverage = orcaCloudAgentCoverageFromAccounts(agent, accounts)?.kind
  if (coverage === 'expired') {
    return 'expired'
  }
  if (coverage === 'notSetUp' || hostEntry?.state === 'signedOut') {
    return 'needsSignIn'
  }
  return null
}

export function cloudAgentRowSignInLabel(signIn: CloudAgentRowSignIn, t: Translate): string {
  return signIn === 'expired'
    ? t('agentSignInStrip.rowExpired', 'Sign-in expired')
    : t('agentSignInStrip.rowNeedsSignIn', 'Needs sign-in')
}

/** Where the fix lives; the row's status opens it (Settings → Agent accounts). */
export function cloudAgentRowSignInTooltip(signIn: CloudAgentRowSignIn, t: Translate): string {
  return signIn === 'expired'
    ? t('agentSignInStrip.rowExpiredTooltip', 'Renew in Settings → Agent accounts')
    : t('agentSignInStrip.rowNeedsSignInTooltip', 'Set up once in Settings → Agent accounts')
}
