import type { AgentStatusState } from '../../../shared/agent-status-types'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionKey,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'

/** A skip is decided before any process is stopped. */
export type AgentSessionRestartSkipReason =
  | 'resume-unsupported'
  | 'missing-session'
  | 'unknown-launch'
  | 'resume-unavailable'
  | 'wsl-resume-unsupported'
  | 'unknown-host'
  | 'remote-unsupported'
  | 'structured-session'
  | 'stale-status'
  | 'non-terminal'
  | 'shell-foreground'
  | 'pane-changed'

export type AgentSessionRestartQueueReason = 'busy' | 'blocked'

/** Identity captured with a queue entry. Execution re-reads the store against this fence. */
export type AgentSessionRestartFence = {
  ptyId: string
  tabId: string
  leafId: string
  worktreeId: string
  tabGeneration: number
  agent: TuiAgent
  providerSessionId: string
  providerSessionKey: AgentProviderSessionKey
  /** Pi and Prime Agent resume by transcript file, not only the provider id. */
  transcriptPath?: string
  /** OMP's resume file is part of the session identity when one was recorded. */
  ompResumeFilePath?: string | null
}

/**
 * One live terminal the collector already decided is an agent pane.
 * `agent` stays a string so a shell or dev server never becomes a target.
 * `executionHostId` null means the host is unknown and must not be treated as local.
 */
export type AgentSessionRestartPane = {
  ptyId: string
  tabId: string
  leafId: string
  worktreeId: string
  workspaceLabel: string
  tabGeneration: number
  agent: string
  providerSession: AgentProviderSessionMetadata | null
  state: AgentStatusState
  structuredHostOwned: boolean
  /** Hydrated status is not evidence the agent is still running. */
  restoredUnconfirmed?: boolean
  /** False when a non-terminal owner restores itself. */
  terminalResumeEligible?: false
  /** The pane's foreground is a shell, so the status row is not the live process. */
  shellForeground?: boolean
  ompResumeFilePath?: string | null
  startupUnavailableReason?: AgentSessionRestartSkipReason
  executionHostId: string | null
  foreignPty: boolean
  /** Codex inside a WSL guest cannot be exact-resumed from this host. */
  wsl: boolean
}

export type AgentSessionRestartPlanInput = {
  panes: readonly AgentSessionRestartPane[]
  /** Enabled catalog ids in display order. Disabled agents are omitted unless one is live. */
  enabledCatalog: readonly TuiAgent[]
}

export type AgentSessionRestartMenuRow = {
  agent: TuiAgent
  label: string
  liveCount: number
  restartableCount?: number
  disabled: boolean
}

type ClassifiedBase = {
  pane: AgentSessionRestartPane
  label: string
  workspaceLabel: string
}

export type AgentSessionRestartTarget = ClassifiedBase &
  (
    | { kind: 'restart'; fence: AgentSessionRestartFence }
    | {
        kind: 'queued'
        fence: AgentSessionRestartFence
        queueReason: AgentSessionRestartQueueReason
      }
    | { kind: 'skipped'; reason: AgentSessionRestartSkipReason }
  )

export type AgentSessionRestartPlan = {
  rows: AgentSessionRestartMenuRow[]
  targets: AgentSessionRestartTarget[]
  /** This host's live agent panes. Remote, unknown, and native-chat panes are not included. */
  restartAllCount: number
}

const CATALOG_INDEX = new Map<string, number>(
  TUI_AGENT_AUTO_PICK_ORDER.map((agent, index) => [agent, index])
)

export function formatRestartAllAgentsLabel(count: number): string {
  return `Restart all agents (${count})`
}

export function formatAgentSessionRestartRowLabel(row: AgentSessionRestartMenuRow): string {
  return row.restartableCount !== undefined && row.restartableCount !== row.liveCount
    ? `${row.label} (${row.restartableCount} of ${row.liveCount} can restart)`
    : `${row.label} (${row.liveCount})`
}

export function agentSessionRestartSkipMessage(reason: AgentSessionRestartSkipReason): string {
  switch (reason) {
    case 'resume-unsupported':
      return 'this CLI cannot resume a session'
    case 'missing-session':
      return 'no saved conversation ID; use Restart with command or complete a turn'
    case 'unknown-launch':
      return 'original launch settings are unavailable; use Restart with command'
    case 'resume-unavailable':
      return 'the recorded session cannot be resumed safely; the original process was left running'
    case 'stale-status':
      return 'the saved status is not a live agent'
    case 'non-terminal':
      return 'this session is not a terminal process'
    case 'shell-foreground':
      return 'a shell is running in this terminal'
    case 'pane-changed':
      return 'the terminal changed before restart'
    case 'wsl-resume-unsupported':
      return 'a WSL Codex session cannot be resumed exactly from this host'
    case 'unknown-host':
      return 'the workspace host is unknown, so the agent was left running'
    case 'remote-unsupported':
      return 'this host cannot replace the agent process in place, so it was left running'
    case 'structured-session':
      return 'a native chat session is not a terminal process'
  }
}

export function agentSessionRestartQueueMessage(reason: AgentSessionRestartQueueReason): string {
  return reason === 'blocked'
    ? 'waiting until the permission prompt is finished'
    : 'waiting until it is idle'
}

/** Shells, dev servers, and unknown programs are not restart targets. */
export function isAgentSessionRestartAgent(agent: string): agent is TuiAgent {
  return isTuiAgent(agent)
}

export function planAgentSessionRestarts(
  input: AgentSessionRestartPlanInput
): AgentSessionRestartPlan {
  const targets = input.panes.flatMap((pane) => {
    const target = classifyAgentSessionRestartPane(pane)
    return target ? [target] : []
  })
  const liveCountByAgent = new Map<TuiAgent, number>()
  for (const target of targets) {
    if (!targetCountsAsLive(target) || !isTuiAgent(target.pane.agent)) {
      continue
    }
    liveCountByAgent.set(target.pane.agent, (liveCountByAgent.get(target.pane.agent) ?? 0) + 1)
  }

  const rows: AgentSessionRestartMenuRow[] = []
  const seen = new Set<TuiAgent>()
  for (const agent of input.enabledCatalog) {
    if (seen.has(agent)) {
      continue
    }
    seen.add(agent)
    const liveCount = liveCountByAgent.get(agent) ?? 0
    if (liveCount > 0) {
      rows.push(menuRow(agent, liveCount))
    }
  }
  const extras = [...liveCountByAgent.keys()]
    .filter((agent) => !seen.has(agent))
    .sort(compareCatalogOrder)
  for (const agent of extras) {
    rows.push(menuRow(agent, liveCountByAgent.get(agent) ?? 0))
  }

  for (const row of rows) {
    row.restartableCount = targets.filter(
      (target) => target.pane.agent === row.agent && target.kind !== 'skipped'
    ).length
    row.disabled = row.restartableCount === 0
  }
  return {
    rows,
    targets,
    restartAllCount: targets.filter((target) => target.kind !== 'skipped').length
  }
}

export function selectAgentSessionRestartTargets(
  targets: readonly AgentSessionRestartTarget[],
  agent: TuiAgent | 'all'
): AgentSessionRestartTarget[] {
  if (agent === 'all') {
    return [...targets]
  }
  return targets.filter((target) => target.pane.agent === agent)
}

export {
  agentSessionRestartFenceHolds,
  agentSessionRestartSessionMatches
} from './agent-session-restart-fence'

export function classifyAgentSessionRestartPane(
  pane: AgentSessionRestartPane
): AgentSessionRestartTarget | null {
  if (!isTuiAgent(pane.agent)) {
    return null
  }
  const label = formatAgentTypeLabel(pane.agent)
  const base = { pane, label, workspaceLabel: pane.workspaceLabel }
  const skipped = (reason: AgentSessionRestartSkipReason): AgentSessionRestartTarget => ({
    ...base,
    kind: 'skipped',
    reason
  })

  // Host and native-chat skips happen before a resume id is required, and they are not live counts.
  if (pane.structuredHostOwned) {
    return skipped('structured-session')
  }
  if (pane.restoredUnconfirmed) {
    return skipped('stale-status')
  }
  if (pane.terminalResumeEligible === false) {
    return skipped('non-terminal')
  }
  if (pane.shellForeground) {
    return skipped('shell-foreground')
  }
  if (
    pane.foreignPty ||
    (pane.executionHostId !== null && pane.executionHostId !== LOCAL_EXECUTION_HOST_ID)
  ) {
    return skipped('remote-unsupported')
  }
  if (pane.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return skipped('unknown-host')
  }
  if (!isResumableTuiAgent(pane.agent)) {
    return skipped('resume-unsupported')
  }
  // Same rule as account restart: only Codex refuses a WSL guest resume here.
  if (pane.agent === 'codex' && pane.wsl) {
    return skipped('wsl-resume-unsupported')
  }

  const session = normalizeAgentProviderSession(pane.providerSession)
  const resumeArgv = session ? getAgentResumeArgv(pane.agent, session) : null
  if (!session || !resumeArgv) {
    return skipped('missing-session')
  }

  if (pane.startupUnavailableReason) {
    return skipped(pane.startupUnavailableReason)
  }

  const fence: AgentSessionRestartFence = {
    ptyId: pane.ptyId,
    tabId: pane.tabId,
    leafId: pane.leafId,
    worktreeId: pane.worktreeId,
    tabGeneration: pane.tabGeneration,
    agent: pane.agent,
    providerSessionId: session.id,
    providerSessionKey: session.key,
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
    ...(pane.ompResumeFilePath ? { ompResumeFilePath: pane.ompResumeFilePath } : {})
  }
  if (pane.state === 'blocked') {
    return { ...base, kind: 'queued', fence, queueReason: 'blocked' }
  }
  if (pane.state !== 'done') {
    return { ...base, kind: 'queued', fence, queueReason: 'busy' }
  }
  return { ...base, kind: 'restart', fence }
}

function targetCountsAsLive(target: AgentSessionRestartTarget): boolean {
  return (
    target.kind !== 'skipped' ||
    target.reason === 'unknown-launch' ||
    target.reason === 'resume-unavailable' ||
    target.reason === 'resume-unsupported' ||
    target.reason === 'missing-session' ||
    target.reason === 'wsl-resume-unsupported'
  )
}

function menuRow(agent: TuiAgent, liveCount: number): AgentSessionRestartMenuRow {
  return {
    agent,
    label: formatAgentTypeLabel(agent),
    liveCount,
    disabled: liveCount === 0
  }
}

function compareCatalogOrder(left: TuiAgent, right: TuiAgent): number {
  const leftIndex = CATALOG_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER
  const rightIndex = CATALOG_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex
  }
  return formatAgentTypeLabel(left).localeCompare(formatAgentTypeLabel(right))
}
