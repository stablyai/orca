// The "Set up Orca Cloud" panel's Agent row (cloud-start onboarding G, agent-accounts v4). It reads
// the Orca account's credentials and sources, links to S0 when nothing is set up, and never blocks Start.
import type { OrcaCloudRunTargetAccess } from '@/components/new-workspace/orca-cloud-run-target-access'
import {
  isOrcaCloudAccountAgent,
  type AgentKeyKind,
  type OrcaCloudAccountAgent
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { orcaCloudAgentCoverage } from './orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsState } from './orca-cloud-agent-accounts-store'

export type OrcaCloudAgentSetupRowModel =
  | { kind: 'hidden' }
  | { kind: 'loading'; agent: OrcaCloudAccountAgent }
  /** Collapsed to one line: nothing to do. */
  | { kind: 'covered'; agent: OrcaCloudAccountAgent; via: 'account' | 'inWorkspace' | AgentKeyKind }
  | { kind: 'notSetUp'; agent: OrcaCloudAccountAgent }
  | { kind: 'expired'; agent: OrcaCloudAccountAgent }
  /** §5c, info only. */
  | { kind: 'killSwitch'; agent: OrcaCloudAccountAgent }
  | { kind: 'signedOut'; agent: OrcaCloudAccountAgent }
  | { kind: 'error'; agent: OrcaCloudAccountAgent }

/** A member can't fix billing, so nothing in this row helps yet (cloud-start C1). */
function billingBlocksMember(access: OrcaCloudRunTargetAccess): boolean {
  switch (access.state) {
    case 'no-plan':
    case 'out-of-hours':
    case 'payment-issue':
      return !access.canManageBilling
    case 'loading':
    case 'unknown':
    case 'signed-out':
    case 'entitled':
      return false
  }
}

export function orcaCloudAgentSetupRow({
  agent,
  access,
  githubBlocked = false,
  accounts
}: {
  /** The composer's agent; only agents with an account path (Claude, Codex) get a row. */
  agent: string | null
  access: OrcaCloudRunTargetAccess
  /** GitHub blocks Start (no remote): the panel shows that instead. */
  githubBlocked?: boolean
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>
}): OrcaCloudAgentSetupRowModel {
  if (!isOrcaCloudAccountAgent(agent) || githubBlocked || billingBlocksMember(access)) {
    return { kind: 'hidden' }
  }
  if (access.state === 'signed-out') {
    return { kind: 'signedOut', agent }
  }
  const { load } = accounts
  switch (load.kind) {
    case 'unavailable':
      return { kind: 'hidden' }
    case 'loading':
      return { kind: 'loading', agent }
    case 'failed':
      return load.error === 'signed_out' ? { kind: 'signedOut', agent } : { kind: 'error', agent }
    case 'ready':
      break
  }
  const coverage = orcaCloudAgentCoverage(agent, load.status, accounts.keyKinds[agent])
  switch (coverage.kind) {
    case 'account':
      return { kind: 'covered', agent, via: 'account' }
    case 'key':
      return { kind: 'covered', agent, via: coverage.keyKind }
    case 'notSetUp':
      return { kind: 'notSetUp', agent }
    case 'expired':
      return { kind: 'expired', agent }
    case 'killSwitch':
      return { kind: 'killSwitch', agent }
    case 'unavailable':
      // Never offered here: like an agent without an account path, the composer shows no row.
      return { kind: 'hidden' }
    case 'inWorkspace':
      // The person's own choice: nothing to set up, so the row is done.
      return { kind: 'covered', agent, via: 'inWorkspace' }
  }
}
