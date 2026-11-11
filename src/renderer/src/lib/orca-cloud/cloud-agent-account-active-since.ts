// When this renderer first saw each agent covered (account or key) in the Orca account's Agent
// accounts, for "a turn ended after the account became active". The server sends no such time, so
// the first covered read stands in; any uncovered read resets it.
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent
} from '../../../../shared/host-agent-sign-in-status'
import { orcaCloudAgentCoverageFromAccounts } from './orca-cloud-agent-accounts-model'
import {
  readOrcaCloudAgentAccounts,
  subscribeOrcaCloudAgentAccounts
} from './orca-cloud-agent-accounts-store'

const activeSince = new Map<HostAgentSignInAgent, number>()
let watching = false

function observe(): void {
  const accounts = readOrcaCloudAgentAccounts()
  if (accounts.load.kind !== 'ready') {
    return
  }
  for (const agent of HOST_AGENT_SIGN_IN_AGENTS) {
    const kind = orcaCloudAgentCoverageFromAccounts(agent, accounts)?.kind
    if (kind === 'account' || kind === 'key') {
      if (!activeSince.has(agent)) {
        activeSince.set(agent, Date.now())
      }
    } else {
      activeSince.delete(agent)
    }
  }
}

/** Null until this renderer has seen the agent covered. */
export function cloudAgentAccountActiveSince(agent: HostAgentSignInAgent): number | null {
  if (!watching) {
    watching = true
    subscribeOrcaCloudAgentAccounts(observe)
  }
  observe()
  return activeSince.get(agent) ?? null
}

/** Tests only. */
export function _resetCloudAgentAccountActiveSinceForTest(): void {
  activeSince.clear()
}
