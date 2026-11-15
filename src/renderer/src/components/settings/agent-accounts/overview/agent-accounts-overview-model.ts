// S3 (agent-accounts spec v4 §7): one row per host, Claude and Codex as columns. Each row summarises
// that host's A16 panel. Orca Cloud is one row for every cloud workspace; cloud sandboxes never get
// their own rows. Verdicts, emails and hints only: never tokens, CLI output or key values.
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent
} from '../../../../../../shared/host-agent-sign-in-status'
import type {
  AgentKeyKind,
  OrcaCloudAgentsStatus
} from '../../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { SshAgentSignInReport } from '../../../../../../shared/ssh-agent-sign-in-types'
import { ORCA_CLOUD_HOST_LABEL } from '../../../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import type { ExecutionHostHealth } from '../../../../../../shared/execution-host/execution-host-health'
import { orcaCloudAgentCoverage } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type {
  AgentHostAvailability,
  AgentHostKind
} from '../../../agent-host-panel/agent-host-capabilities'

export type OverviewAgent = HostAgentSignInAgent

/** §7 annotation 4, plus the Orca Cloud row's cells (build-sheet and panel wording). */
export type OverviewCell =
  | { kind: 'signedIn' }
  | { kind: 'signedInChecked'; checkedAt: number }
  | { kind: 'signedOut' }
  | { kind: 'expired' }
  | { kind: 'apiKey' }
  /** §7: an API key signs the agent in while a CLI login underneath goes unused. */
  | { kind: 'apiKeyOverrides' }
  | { kind: 'notInstalled' }
  | { kind: 'notConnected' }
  | { kind: 'checking' }
  | { kind: 'couldntCheck' }
  | { kind: 'cloudAccount' }
  | { kind: 'cloudKey'; keyKind: AgentKeyKind; member: boolean }
  | { kind: 'cloudNotSetUp' }
  | { kind: 'cloudExpired' }
  | { kind: 'cloudPaused' }
  | { kind: 'cloudNotOffered' }
  /** The person signs this agent in inside each workspace (their choice). */
  | { kind: 'cloudInWorkspace' }

export type OverviewHost = {
  hostId: ExecutionHostId
  label: string
  kind: Exclude<AgentHostKind, 'cloud'>
  availability: AgentHostAvailability
  /** The sidebar's health, handed to the panel so it reads the host the same way. */
  health: ExecutionHostHealth
  environmentId: string | null
}

export type OverviewProbe = {
  /** Classic SSH entries may carry hasLogin. */
  report: SshAgentSignInReport | null
  /** Asked on this open and not answered yet. */
  checking: boolean
  /** Asked and the host answered nothing. */
  failed: boolean
  /** Signed in at the last cached verdict, signed out now (§7: derived on the client). */
  expired: readonly OverviewAgent[]
}

export type OverviewAction =
  | { kind: 'review'; agent: OverviewAgent }
  | { kind: 'checkAgain' }
  | { kind: 'accounts' }
  | { kind: 'manage' }

export type OverviewRow = {
  id: string
  /** Null for the Orca Cloud row, which opens S0 rather than one sandbox's panel. */
  hostId: ExecutionHostId | null
  label: string
  kind: AgentHostKind
  availability: AgentHostAvailability
  cells: Record<OverviewAgent, OverviewCell>
  attention: boolean
  action: OverviewAction | null
}

const ATTENTION: ReadonlySet<OverviewCell['kind']> = new Set([
  'expired',
  'apiKeyOverrides',
  'couldntCheck',
  'cloudExpired'
])

function hostCell(
  host: OverviewHost,
  probe: OverviewProbe | undefined,
  agent: OverviewAgent
): OverviewCell {
  if (probe?.expired.includes(agent)) {
    return { kind: 'expired' }
  }
  const report = probe?.report ?? null
  const entry = report?.agents.find((candidate) => candidate.agent === agent)
  if (!entry) {
    if (probe?.checking) {
      return { kind: 'checking' }
    }
    if (host.availability !== 'available') {
      return { kind: 'notConnected' }
    }
    return probe?.failed ? { kind: 'couldntCheck' } : { kind: 'checking' }
  }
  switch (entry.state) {
    case 'signedIn':
      if (entry.method === 'apiKey') {
        return 'hasLogin' in entry && entry.hasLogin === true
          ? { kind: 'apiKeyOverrides' }
          : { kind: 'apiKey' }
      }
      // A host that can't answer now shows its last verdict with the date (never woken to check).
      return host.availability === 'available' && !probe?.failed
        ? { kind: 'signedIn' }
        : { kind: 'signedInChecked', checkedAt: report?.checkedAt ?? 0 }
    case 'signedOut':
      return { kind: 'signedOut' }
    case 'notInstalled':
      return { kind: 'notInstalled' }
    case 'unknown':
      return { kind: 'couldntCheck' }
  }
}

function hostAction(host: OverviewHost, cells: OverviewRow['cells']): OverviewAction | null {
  if (host.kind === 'local') {
    return { kind: 'accounts' }
  }
  const urgent = HOST_AGENT_SIGN_IN_AGENTS.find((agent) =>
    ['expired', 'signedOut', 'apiKeyOverrides'].includes(cells[agent].kind)
  )
  if (urgent) {
    return { kind: 'review', agent: urgent }
  }
  return HOST_AGENT_SIGN_IN_AGENTS.some((agent) => cells[agent].kind === 'couldntCheck')
    ? { kind: 'checkAgain' }
    : null
}

function cloudCell(
  agent: OverviewAgent,
  status: OrcaCloudAgentsStatus,
  keyKind: AgentKeyKind | null,
  member: boolean
): OverviewCell {
  const coverage = orcaCloudAgentCoverage(agent, status, keyKind)
  switch (coverage.kind) {
    case 'account':
      return { kind: 'cloudAccount' }
    case 'key':
      return { kind: 'cloudKey', keyKind: coverage.keyKind, member }
    case 'notSetUp':
      return { kind: 'cloudNotSetUp' }
    case 'expired':
      return { kind: 'cloudExpired' }
    case 'killSwitch':
      return { kind: 'cloudPaused' }
    case 'unavailable':
      return { kind: 'cloudNotOffered' }
    case 'inWorkspace':
      return { kind: 'cloudInWorkspace' }
  }
}

export function overviewRows(args: {
  hosts: readonly OverviewHost[]
  probes: Readonly<Record<string, OverviewProbe>>
  /** Null while signed out of Orca or without Cloud access: no Orca Cloud row. */
  cloud: {
    status: OrcaCloudAgentsStatus
    keyKinds: Record<OverviewAgent, AgentKeyKind | null>
    member: boolean
  } | null
}): OverviewRow[] {
  const rows: OverviewRow[] = args.hosts.map((host) => {
    const probe = args.probes[host.hostId]
    const cells = {
      claude: hostCell(host, probe, 'claude'),
      codex: hostCell(host, probe, 'codex')
    }
    return {
      id: host.hostId,
      hostId: host.hostId,
      label: host.label,
      kind: host.kind,
      availability: host.availability,
      cells,
      attention: HOST_AGENT_SIGN_IN_AGENTS.some((agent) => ATTENTION.has(cells[agent].kind)),
      action: hostAction(host, cells)
    }
  })
  if (args.cloud) {
    const { status, keyKinds, member } = args.cloud
    const cells = {
      claude: cloudCell('claude', status, keyKinds.claude, member),
      codex: cloudCell('codex', status, keyKinds.codex, member)
    }
    rows.push({
      id: 'orca-cloud',
      hostId: null,
      label: ORCA_CLOUD_HOST_LABEL,
      kind: 'cloud',
      availability: 'available',
      cells,
      attention: HOST_AGENT_SIGN_IN_AGENTS.some((agent) => ATTENTION.has(cells[agent].kind)),
      action: { kind: 'manage' }
    })
  }
  // This computer, then Orca Cloud (the main path), then rows that need attention, then the rest.
  const pinned = (row: OverviewRow): number =>
    row.kind === 'local' ? 0 : row.kind === 'cloud' ? 1 : 2
  return [...rows].sort(
    (a, b) => pinned(a) - pinned(b) || Number(b.attention) - Number(a.attention)
  )
}
