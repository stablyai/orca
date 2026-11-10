// Panel section 1 on hosts that keep their own login (this computer, SSH with Orca server, WSL,
// recipe VMs, paired hosts): the host's own verdicts, never tokens or CLI output.
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent,
  type HostAgentSignInReport
} from '../../../../shared/host-agent-sign-in-status'
import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type HostAgentPanelState =
  | 'signedIn'
  | 'apiKey'
  /** An API key signs the agent in, and a CLI login underneath goes unused (classic SSH reports it). */
  | 'apiKeyOverrides'
  | 'signedOut'
  | 'notInstalled'
  | 'unknown'

export type HostAgentPanelRow = {
  agent: HostAgentSignInAgent
  state: HostAgentPanelState
  /** A CLI login Orca can run the agent's own sign-out for (API-key logins live in the env). */
  canSignOut: boolean
}

export function hostAgentPanelRows(report: HostAgentSignInReport | null): HostAgentPanelRow[] {
  return HOST_AGENT_SIGN_IN_AGENTS.map((agent) => {
    const entry = report?.agents.find((candidate) => candidate.agent === agent)
    if (!entry) {
      return { agent, state: 'unknown', canSignOut: false }
    }
    if (entry.state === 'signedIn') {
      return entry.method === 'apiKey'
        ? {
            agent,
            state: 'hasLogin' in entry && entry.hasLogin === true ? 'apiKeyOverrides' : 'apiKey',
            canSignOut: false
          }
        : { agent, state: 'signedIn', canSignOut: true }
    }
    return { agent, state: entry.state, canSignOut: false }
  })
}

/** Section 2 off Cloud: the desktop Agent API keys Orca sends to agents on this host. */
export function agentApiKeysForHost(
  keys: readonly AgentApiKeySummary[],
  hostId: ExecutionHostId
): AgentApiKeySummary[] {
  return keys.filter(
    (key) => key.hostScope.kind === 'all' || key.hostScope.hostIds.includes(hostId)
  )
}
