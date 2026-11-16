// Panel section 1 on Orca Cloud (spec §4 annotation 12): per agent, where this workspace's
// credential comes from, read from the Orca account (GET /v1/agent-credentials + /v1/agent-sources),
// never from the sandbox. No probe, no sign-in, no sign-out.
import {
  ORCA_CLOUD_ACCOUNT_AGENTS,
  isUsableAgentCredential,
  orcaCloudProviderState,
  type AgentKeyKind,
  type AgentSource,
  type AgentSourcesView,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentsStatus
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { orcaCloudAgentCoverage } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'

type CloudAgentPanelStatus =
  | { kind: 'account'; label: string | null }
  | { kind: 'key'; keyKind: AgentKeyKind }
  | { kind: 'notSetUp' }
  | { kind: 'expired' }
  /** No account path and no key: the agent signs in inside this workspace (§5c). */
  | { kind: 'signsInHere'; reason: 'paused' | 'notOffered' | 'chosen' }
  /** D13: a shared workspace never uses personal accounts or keys, and no team key covers it. */
  | { kind: 'sharedUnavailable' }

/** The two-way Source (Your account / the winning key); present only when both are possible. */
export type CloudAgentPanelSource = { value: AgentSource; keyKind: AgentKeyKind }

export type CloudAgentPanelRow = {
  agent: OrcaCloudAccountAgent
  status: CloudAgentPanelStatus
  source: CloudAgentPanelSource | null
}

function chosenSource(view: AgentSourcesView, agent: OrcaCloudAccountAgent): AgentSource {
  return view.effective?.[agent]?.source ?? view.defaults[agent] ?? null
}

/**
 * D13: in a shared workspace only a team or repository key applies; personal accounts and keys
 * never do. The Source shows what applies and can't be changed there.
 */
function sharedRow(
  agent: OrcaCloudAccountAgent,
  here: OrcaCloudAgentsStatus,
  keyKind: AgentKeyKind | null
): CloudAgentPanelRow {
  const shared = here.sources.coveredByKey[agent] ? (keyKind ?? 'team') : null
  if (!shared || shared === 'personal') {
    return { agent, status: { kind: 'sharedUnavailable' }, source: null }
  }
  return {
    agent,
    status: { kind: 'key', keyKind: shared },
    source: { value: 'key', keyKind: shared }
  }
}

/**
 * `workspace` is this workspace's Sources (with its override); null until read, when the account-wide
 * default stands in.
 */
export function cloudAgentPanelRows(
  status: OrcaCloudAgentsStatus,
  keyKinds: Record<OrcaCloudAccountAgent, AgentKeyKind | null>,
  workspace: AgentSourcesView | null
): CloudAgentPanelRow[] {
  const here: OrcaCloudAgentsStatus = workspace ? { ...status, sources: workspace } : status
  if (workspace?.sharedWorkspace === true) {
    return ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) => sharedRow(agent, here, keyKinds[agent]))
  }
  return ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) => {
    const coverage = orcaCloudAgentCoverage(agent, here, keyKinds[agent])
    const credential = here.credentials[agent]
    const covered = here.sources.coveredByKey[agent]
    const keyKind = covered ? (keyKinds[agent] ?? 'team') : null
    const usable =
      orcaCloudProviderState(here.credentials, agent) === 'on' &&
      isUsableAgentCredential(credential.state)
    const source: CloudAgentPanelSource | null =
      usable && keyKind ? { value: chosenSource(here.sources, agent), keyKind } : null
    switch (coverage.kind) {
      case 'account':
        return {
          agent,
          status: { kind: 'account', label: credential.label?.trim() || null },
          source
        }
      case 'key':
        return { agent, status: { kind: 'key', keyKind: coverage.keyKind }, source }
      case 'notSetUp':
        return { agent, status: { kind: 'notSetUp' }, source }
      case 'expired':
        return { agent, status: { kind: 'expired' }, source }
      case 'killSwitch':
        return { agent, status: { kind: 'signsInHere', reason: 'paused' }, source }
      case 'unavailable':
        return { agent, status: { kind: 'signsInHere', reason: 'notOffered' }, source }
      case 'inWorkspace':
        // Nothing of Orca's applies, so there is no Source to switch here either.
        return { agent, status: { kind: 'signsInHere', reason: 'chosen' }, source: null }
    }
  })
}
