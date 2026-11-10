// Private layer, Orca Cloud only: a cloud Claude/Codex pane that started without a sign-in sits at
// its own "Not logged in" screen, but SessionStart reports it as done. The sidebar row says why
// instead of "Done", using the Orca account's Agent accounts and the sandbox's own sign-in report.
import type { AgentDotState } from '@/components/AgentStateDot'
import type { Translate } from '@/i18n/use-translate'
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent,
  type HostAgentSignInEntry
} from '../../../../shared/host-agent-sign-in-status'
import { orcaCloudAgentCoverage } from './orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsState } from './orca-cloud-agent-accounts-store'

export type CloudAgentRowSignIn = 'notSignedIn' | 'expired'

export function cloudRowSignInAgent(agentType: string): HostAgentSignInAgent | null {
  return HOST_AGENT_SIGN_IN_AGENTS.find((agent) => agent === agentType) ?? null
}

/**
 * Only a row that has not finished a turn this session can be waiting on sign-in: a finished
 * turn proves the agent reached its provider, so its Done stays.
 */
export function isCloudRowSignInCandidate(row: {
  agentType: string
  dotState: AgentDotState
  sessionBoundary: boolean | undefined
  isChildRow: boolean
}): boolean {
  return (
    !row.isChildRow &&
    row.sessionBoundary === true &&
    (row.dotState === 'done' || row.dotState === 'idle') &&
    cloudRowSignInAgent(row.agentType) !== null
  )
}

/** The sandbox's own verdict wins; without one, the Orca account's coverage decides. */
export function cloudAgentRowSignIn(
  agent: HostAgentSignInAgent,
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>,
  hostEntry: HostAgentSignInEntry | null
): CloudAgentRowSignIn | null {
  // Signed in on the sandbox (account placeholder, key or a /login there): nothing to show.
  if (hostEntry?.state === 'signedIn' || hostEntry?.state === 'notInstalled') {
    return null
  }
  const coverage =
    accounts.load.kind === 'ready'
      ? orcaCloudAgentCoverage(agent, accounts.load.status, accounts.keyKinds[agent]).kind
      : null
  if (coverage === 'expired') {
    return 'expired'
  }
  if (hostEntry?.state === 'signedOut' || coverage === 'notSetUp') {
    return 'notSignedIn'
  }
  return null
}

export function cloudAgentRowSignInLabel(signIn: CloudAgentRowSignIn, t: Translate): string {
  return signIn === 'expired'
    ? t('agentSignInStrip.rowExpired', 'Sign-in expired')
    : t('agentSignInStrip.rowNotSignedIn', 'Not signed in')
}
