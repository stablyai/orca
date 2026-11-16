// The cloud build sheet's Agents row: how each
// agent will authenticate in this workspace, known at mount from the Orca account, never from the
// sandbox. Pure: the component decides the row's height once and renders whatever this returns.
import {
  ORCA_CLOUD_ACCOUNT_AGENTS,
  type AgentKeyKind,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentSetup,
  type OrcaCloudAgentSetupFailure
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { CloudOfferableDesktopKey } from '@/components/cloud-agent-setup/cloud-agent-readiness'
import {
  orcaCloudAgentCoverage,
  type OrcaCloudAgentCoverage
} from './orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsState } from './orca-cloud-agent-accounts-store'

export type BuildAgentVia = 'account' | AgentKeyKind

export type BuildAgentsRunningSetup = Exclude<
  OrcaCloudAgentSetup,
  { phase: 'idle' | 'saved' | 'failed' }
>

export type BuildAgentsRowModel =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  /** Every covered agent and where its credential comes from. */
  | {
      kind: 'ready'
      covered: readonly { agent: OrcaCloudAccountAgent; via: BuildAgentVia }[]
      /** The Orca-account label (the vendor email), when one account covers every agent. */
      label: string | null
      /** An account credential within its renewal window: a quiet Renew. */
      expiring: OrcaCloudAccountAgent | null
    }
  /** Nothing covers any agent yet; Set up runs the Cloud agent sign-ins setup inline, once ever. */
  | { kind: 'offer'; agents: readonly OrcaCloudAccountAgent[] }
  /** The one-time setup is running on this computer. `step` is 1-based. */
  | {
      kind: 'setup'
      agent: OrcaCloudAccountAgent
      setup: BuildAgentsRunningSetup
      step: number
      of: number
    }
  /** The setup stopped; the workspace still opens. */
  | { kind: 'failed'; agent: OrcaCloudAccountAgent; error: OrcaCloudAgentSetupFailure }
  /** The account credential expired or was revoked and no key covers the agent. */
  | { kind: 'expired'; agent: OrcaCloudAccountAgent }
  /**
   * No Orca-account path for the agent and no key covers it, so it signs in inside this
   * workspace. `paused` = the kill switch; `notOffered` = this server never offered it (flag off).
   */
  | { kind: 'killSwitch'; agent: OrcaCloudAccountAgent; reason: 'paused' | 'notOffered' }
  /** A key only in this computer's vault; it never reaches the sandbox unasked. */
  | { kind: 'desktopKey'; key: CloudOfferableDesktopKey }
  /** Couldn't read the Orca account; the workspace still opens. */
  | { kind: 'error' }

function covered(coverage: OrcaCloudAgentCoverage): BuildAgentVia | null {
  switch (coverage.kind) {
    case 'account':
      return 'account'
    case 'key':
      return coverage.keyKind
    case 'notSetUp':
    case 'expired':
    case 'killSwitch':
    case 'unavailable':
    case 'inWorkspace':
      return null
  }
}

export function buildAgentsRow(args: {
  /** `queue` is the Set up order; it drives "1 of 2". */
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'setups' | 'keyKinds' | 'queue'>
  /** This computer's keys no Cloud secret covers; empty until read. */
  desktopKeys: readonly CloudOfferableDesktopKey[]
}): BuildAgentsRowModel {
  const { load, setups, keyKinds } = args.accounts
  const queue = args.accounts.queue.agents
  for (const agent of ORCA_CLOUD_ACCOUNT_AGENTS) {
    const setup = setups[agent]
    if (setup.phase === 'failed') {
      return { kind: 'failed', agent, error: setup.error }
    }
    if (setup.phase !== 'idle' && setup.phase !== 'saved') {
      const index = queue.indexOf(agent)
      return {
        kind: 'setup',
        agent,
        setup,
        step: index === -1 ? 1 : index + 1,
        of: Math.max(queue.length, 1)
      }
    }
  }
  switch (load.kind) {
    case 'unavailable':
      return { kind: 'hidden' }
    case 'loading':
      return { kind: 'loading' }
    case 'failed':
      return { kind: 'error' }
    case 'ready':
      break
  }
  const status = load.status
  const coverage = ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) => ({
    agent,
    coverage: orcaCloudAgentCoverage(agent, status, keyKinds[agent])
  }))
  const paused = coverage.find((entry) => entry.coverage.kind === 'killSwitch')
  if (paused) {
    return { kind: 'killSwitch', agent: paused.agent, reason: 'paused' }
  }
  // Never offered: no Set up to show, so the agent signs in inside the workspace like the kill switch.
  const notOffered = coverage.find((entry) => entry.coverage.kind === 'unavailable')
  if (notOffered) {
    return { kind: 'killSwitch', agent: notOffered.agent, reason: 'notOffered' }
  }
  const expired = coverage.find((entry) => entry.coverage.kind === 'expired')
  if (expired) {
    return { kind: 'expired', agent: expired.agent }
  }
  const ready = coverage.flatMap(({ agent, coverage: c }) => {
    const via = covered(c)
    return via ? [{ agent, via }] : []
  })
  if (ready.length === 0) {
    const key = args.desktopKeys.find((candidate) =>
      ORCA_CLOUD_ACCOUNT_AGENTS.some((agent) => agent === candidate.agent)
    )
    // An agent the person signs in inside each workspace is never offered the one-time setup.
    const offered = coverage.filter((entry) => entry.coverage.kind !== 'inWorkspace')
    return key
      ? { kind: 'desktopKey', key }
      : offered.length > 0
        ? { kind: 'offer', agents: offered.map((entry) => entry.agent) }
        : { kind: 'hidden' }
  }
  const viaAccount = ready.filter((entry) => entry.via === 'account')
  const labels = new Set(
    viaAccount.map((entry) => status.credentials[entry.agent].label?.trim() || null)
  )
  const [onlyLabel] = labels
  return {
    kind: 'ready',
    covered: ready,
    label: viaAccount.length === ready.length && labels.size === 1 ? (onlyLabel ?? null) : null,
    expiring:
      viaAccount.find((entry) => status.credentials[entry.agent].state === 'expiring')?.agent ??
      null
  }
}

/** The row's height class, decided once at mount: a line only when ready then. */
export type BuildAgentsRowDensity = 'line' | 'twoLine'

export function buildAgentsRowDensity(model: BuildAgentsRowModel): BuildAgentsRowDensity {
  return model.kind === 'ready' ? 'line' : 'twoLine'
}

/** The agents Set up runs, in order: each one that nothing covers yet. */
export function buildAgentsToSetUp(model: BuildAgentsRowModel): readonly OrcaCloudAccountAgent[] {
  switch (model.kind) {
    case 'offer':
      return model.agents
    case 'expired':
    case 'failed':
      return [model.agent]
    case 'ready':
      return model.expiring ? [model.expiring] : []
    case 'hidden':
    case 'loading':
    case 'setup':
    case 'killSwitch':
    case 'desktopKey':
    case 'error':
      return []
  }
}
