import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { getAgentResumeArgv, isResumableTuiAgent } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'
import {
  isAutomaticHibernationAllowed,
  isLiveResumeAnchorForCompletedAgent
} from './live-resume-anchor-record'
import type { AgentHibernationPlannerSnapshot } from './agent-hibernation-planner-snapshot'

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
  foregroundTerminalLastSeenAtByTabId: AgentHibernationPlannerSnapshot['foregroundTerminalLastSeenAtByTabId']
  ptyBindingFirstSeenAtByPaneKey: Record<string, number | undefined>
  boundaryResolvedAtByPaneKey: Record<string, number | undefined>
  mobileLockedPtyIds: Set<string>
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
    mobileLockedPtyIds
  } = args
  const sleepingRecord = sleepingAgentSessionsByPaneKey[entry.paneKey]
  // Why: a completed turn leaves the TUI alive and resumable, so every resumable
  // agent keeps a live resume anchor (#10238). That anchor is not a sleep record —
  // treating it as one is what stopped non-Pi agents hibernating at all.
  const hasOnlyLiveResumeAnchor = isLiveResumeAnchorForCompletedAgent(
    entry,
    sleepingRecord,
    tab.worktreeId
  )
  if (
    entry.state !== 'done' ||
    entry.interrupted === true ||
    Boolean(entry.subagents?.length) ||
    hasUnsettledOrUnknownDispatch(entry) ||
    (sleepingRecord && !hasOnlyLiveResumeAnchor) ||
    // Why: a fenced worker must never be auto-relaunched; killing it would also
    // erase the fence, since the capture does not copy it.
    !isAutomaticHibernationAllowed(sleepingRecord)
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
  // Why: anchor on when `done` was first reported, not on the last status write —
  // OSC 9999 repaints and reconnect replays advance `updatedAt` and would restart
  // the countdown forever. Floors then restore the grace `updatedAt` gave by accident:
  // returning to the tab, a fresh PTY binding (wake / app restart), and the moment a
  // session-boundary done became a real completion.
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
  const inputAt = lastTerminalInputAtByPaneKey[entry.paneKey]
  // Why: killing the PTY discards the TUI composer's draft and any queued
  // messages. The old input-after-done compare missed drafts typed while the
  // agent was still working — the class that lost a user's draft in prod.
  if (
    typeof inputAt === 'number' &&
    Number.isFinite(inputAt) &&
    lastInputBlocksHibernation(entry, inputAt)
  ) {
    return null
  }
  const livePane = getPaneLivePtyId(entry, layout)
  if (!livePane) {
    return null
  }
  const { leafId, ptyId } = livePane
  const runtimePtyId = toRuntimePtyId(ptyId)
  if (!livePtyIds.has(runtimePtyId) || mobileLockedPtyIds.has(runtimePtyId)) {
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
    inputAt: typeof inputAt === 'number' && Number.isFinite(inputAt) ? inputAt : 0
  }
}
