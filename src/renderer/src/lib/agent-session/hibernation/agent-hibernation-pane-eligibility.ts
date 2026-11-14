import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentResumeArgv } from '../../../../../shared/agent-launch/startup/agent-resume-argv'
import { isResumableTuiAgent } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'
import { isLiveResumeAnchorForCompletedAgent } from '../../../../../shared/agent-session/lifecycle/resume/live-resume-anchor-record'
import { agentTurnEndedUncleanly } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { AgentHibernationPlannerSnapshot } from './agent-hibernation-planner-snapshot'
import type { RuntimeTerminalAttention } from '../../../../../shared/runtime-terminal-contracts'

export type EligiblePane = {
  paneKey: string
  tabId: string
  leafId: string
  ptyId: string
  runtimePtyId: string
  agentType: string
  providerSessionKey: string
  providerSessionId: string
  providerTranscriptPath: string
  state: AgentStatusEntry['state']
  stateStartedAt: number
  effectiveIdleStart: number
  inputAt: number
}

export function toRuntimePtyId(ptyId: string): string {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? ptyId
}

export function getEntryTabId(entry: AgentStatusEntry): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  return parsePaneKey(entry.paneKey)?.tabId ?? null
}

function getPaneLivePtyId(
  entry: AgentStatusEntry,
  layout: TerminalLayoutSnapshot | undefined
): { leafId: string; ptyId: string } | null {
  const parsed = parsePaneKey(entry.paneKey)
  if (!parsed || (entry.tabId && parsed.tabId !== entry.tabId)) {
    return null
  }
  const ptyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  return ptyId ? { leafId: parsed.leafId, ptyId } : null
}

// Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement makes sleep safe.
const hasUnsettledOrUnknownDispatch = ({ orchestration }: AgentStatusEntry): boolean =>
  orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false

export function getEligiblePane(args: {
  entry: AgentStatusEntry
  tab: TerminalTab
  layout: TerminalLayoutSnapshot | undefined
  livePtyIds: Set<string>
  sleepingAgentSessionsByPaneKey: AgentHibernationPlannerSnapshot['sleepingAgentSessionsByPaneKey']
  lastTerminalInputAtByPaneKey: AgentHibernationPlannerSnapshot['lastTerminalInputAtByPaneKey']
  attentionByPtyId: Record<string, RuntimeTerminalAttention | undefined>
  foregroundTerminalLastSeenAtByTabId: AgentHibernationPlannerSnapshot['foregroundTerminalLastSeenAtByTabId']
  ptyBindingFirstSeenAtByPaneKey: Record<string, number | undefined>
  boundaryResolvedAtByPaneKey: Record<string, number | undefined>
  inUsePtyIds: Set<string>
  now: number
  idleMs: number
}): EligiblePane | null {
  const {
    entry,
    tab,
    layout,
    livePtyIds,
    sleepingAgentSessionsByPaneKey,
    lastTerminalInputAtByPaneKey,
    foregroundTerminalLastSeenAtByTabId,
    ptyBindingFirstSeenAtByPaneKey,
    boundaryResolvedAtByPaneKey,
    inUsePtyIds
  } = args
  const sleepingRecord = sleepingAgentSessionsByPaneKey[entry.paneKey]
  // Every resumable agent has a live anchor after completion; it is not a sleep capture and must not block hibernation.
  const hasOnlyLiveResumeAnchor = isLiveResumeAnchorForCompletedAgent(
    entry,
    sleepingRecord,
    tab.worktreeId
  )
  if (
    entry.state !== 'done' ||
    agentTurnEndedUncleanly(entry) ||
    Boolean(entry.subagents?.length) ||
    hasUnsettledOrUnknownDispatch(entry) ||
    (sleepingRecord && !hasOnlyLiveResumeAnchor)
  ) {
    return null
  }
  if (
    getEntryTabId(entry) !== tab.id ||
    (entry.worktreeId && entry.worktreeId !== tab.worktreeId)
  ) {
    return null
  }
  if (!entry.agentType || !isResumableTuiAgent(entry.agentType) || !entry.providerSession) {
    return null
  }
  if (!getAgentResumeArgv(entry.agentType, entry.providerSession)) {
    return null
  }
  // Anchor on first done, not repaint/replay updatedAt; floor by last foreground visit, fresh PTY binding and real completion boundary.
  const floors = [
    entry.stateStartedAt,
    foregroundTerminalLastSeenAtByTabId[tab.id],
    ptyBindingFirstSeenAtByPaneKey[entry.paneKey],
    boundaryResolvedAtByPaneKey[entry.paneKey]
  ]
  const effectiveIdleStart = Math.max(
    ...floors.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0))
  )
  if (args.now - effectiveIdleStart < args.idleMs) {
    return null
  }
  const livePane = getPaneLivePtyId(entry, layout)
  if (!livePane) {
    return null
  }
  const { leafId, ptyId } = livePane
  const runtimePtyId = toRuntimePtyId(ptyId)
  const attention = args.attentionByPtyId[runtimePtyId]
  if (!livePtyIds.has(runtimePtyId) || inUsePtyIds.has(runtimePtyId) || attention?.shownRemotely) {
    return null
  }
  // Input from a paired client or phone reaches the host, not this window's own input stamps.
  const inputAt = latestFinite(
    lastTerminalInputAtByPaneKey[entry.paneKey],
    attention?.lastInputAt ?? undefined
  )
  // Killing the PTY loses drafts/queued input typed during working too; input-after-done alone misses them.
  if (inputAt !== null && lastInputBlocksHibernation(entry, inputAt)) {
    return null
  }
  return {
    paneKey: entry.paneKey,
    tabId: tab.id,
    leafId,
    ptyId,
    runtimePtyId,
    agentType: entry.agentType,
    providerSessionKey: entry.providerSession.key,
    providerSessionId: entry.providerSession.id,
    providerTranscriptPath: entry.providerSession.transcriptPath ?? '',
    state: entry.state,
    stateStartedAt: entry.stateStartedAt,
    effectiveIdleStart,
    inputAt: inputAt ?? 0
  }
}

function latestFinite(...values: (number | undefined)[]): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  return finite.length > 0 ? Math.max(...finite) : null
}
