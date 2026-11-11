// Private layer, Orca Cloud only: a cloud Claude/Codex pane whose agent isn't signed in sits at its
// own "Not logged in" screen, yet its row would read "Done" or "Idle". The row says why instead.
// The source of truth is the Orca account's Agent accounts (credential state and providerState, via
// the shared coverage selector). While they say not set up, expired or revoked, the sign-in state
// wins over every idle/done row shape (hook, mirrored or title-derived).
import type { AgentDotState } from '@/components/AgentStateDot'
import type { Translate } from '@/i18n/use-translate'
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

/** Row states that claim nothing live: a sign-in state replaces them. Working and waiting keep theirs. */
const SIGN_IN_OVERRIDABLE_DOTS: ReadonlySet<AgentDotState> = new Set([
  'done',
  'idle',
  'unverifiable',
  'unconfirmed'
])

/** A main Claude/Codex row at rest; whether it is on Orca Cloud is checked after. */
export function isCloudRowSignInCandidate(row: {
  agentType: string
  dotState: AgentDotState
  isChildRow: boolean
}): boolean {
  return (
    !row.isChildRow &&
    SIGN_IN_OVERRIDABLE_DOTS.has(row.dotState) &&
    cloudRowSignInAgent(row.agentType) !== null
  )
}

/**
 * Agent accounts decide.
 * - Not set up -> needsSignIn; expired or revoked -> expired. These win over the row's turn
 *   evidence and over the sandbox reporting an Orca-account placeholder or key as signed in; only
 *   a sign-in made on the sandbox itself (cliLogin) clears them.
 * - Covered (account or key): normal, unless the sandbox reports signedOut, and then only until a
 *   turn ends after the account became active (`activeSince`).
 * - Paused or never offered: only a sandbox signedOut shows needsSignIn. A read not ready yet
 *   shows nothing; the row updates when it lands.
 */
export function cloudAgentRowSignIn(
  agent: HostAgentSignInAgent,
  accounts: OrcaCloudAgentAccountsRead,
  hostEntry: HostAgentSignInEntry | null,
  turn: { turnEndedAt?: number; activeSince: number | null }
): CloudAgentRowSignIn | null {
  if (hostEntry?.state === 'notInstalled') {
    return null
  }
  const coverage = orcaCloudAgentCoverageFromAccounts(agent, accounts)?.kind
  if (coverage === 'expired' || coverage === 'notSetUp') {
    if (hostEntry?.state === 'signedIn' && hostEntry.method === 'cliLogin') {
      return null
    }
    return coverage === 'expired' ? 'expired' : 'needsSignIn'
  }
  if (hostEntry?.state !== 'signedOut') {
    return null
  }
  const turnEndedSinceActive =
    turn.activeSince !== null &&
    turn.turnEndedAt !== undefined &&
    turn.turnEndedAt > turn.activeSince
  return turnEndedSinceActive ? null : 'needsSignIn'
}

export function cloudAgentRowSignInLabel(signIn: CloudAgentRowSignIn, t: Translate): string {
  return signIn === 'expired'
    ? t('agentSignInStrip.rowExpired', 'Sign-in expired')
    : t('agentSignInStrip.rowNeedsSignIn', 'Needs sign-in')
}

/** Where the fix lives; the row's status opens it (Settings → Agent accounts). */
export function cloudAgentRowSignInTooltip(signIn: CloudAgentRowSignIn, t: Translate): string {
  return signIn === 'expired'
    ? t('agentSignInStrip.rowExpiredTooltip', 'Renew once for Orca Cloud')
    : t('agentSignInStrip.rowNeedsSignInTooltip', 'Set up once for Orca Cloud')
}
