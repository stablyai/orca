import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { GlobalSettings, TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

export const DEFAULT_AGENT_HIBERNATION_IDLE_MS = 30 * 60 * 1000
export const MIN_AGENT_HIBERNATION_IDLE_MS = 60 * 1000
export const MAX_AGENT_HIBERNATION_IDLE_MS = 24 * 60 * 60 * 1000

export type AgentHibernationPlannerSnapshot = {
  settings: Pick<GlobalSettings, 'experimentalAgentHibernation' | 'agentHibernationIdleMs'> | null
  activeWorktreeId: string | null
  foregroundWorktreeIds: string[]
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  ptyIdsByTabId: Record<string, string[] | undefined>
  runtimeLivePtyIdsByWorktreeId?: Record<string, string[] | undefined>
  runtimeLivenessRequiredWorktreeIds?: string[]
  mobileLockedPtyIds: string[]
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  lastTerminalInputAtByPaneKey: Record<string, number | undefined>
  now: number
}

export type AgentHibernationCandidate = {
  id: string
  worktreeId: string
  paneKey: string
  tabId: string
  leafId: string
  paneKeys: string[]
  targetPtyIds: string[]
  expectedRuntimePtyIds: string[]
  signature: string
}

export type AgentHibernationConfirmationState = Record<string, string>

export type AgentHibernationPlan = {
  candidates: AgentHibernationCandidate[]
  confirmationState: AgentHibernationConfirmationState
}

type EligiblePane = {
  paneKey: string
  tabId: string
  leafId: string
  ptyId: string
  runtimePtyId: string
  providerSessionId: string
  state: AgentStatusEntry['state']
  updatedAt: number
  inputAt: number
}

function toRuntimePtyId(ptyId: string): string {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? ptyId
}

export function getEffectiveAgentHibernationIdleMs(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_AGENT_HIBERNATION_IDLE_MS &&
    value <= MAX_AGENT_HIBERNATION_IDLE_MS
    ? value
    : DEFAULT_AGENT_HIBERNATION_IDLE_MS
}

function getLivePtyIdsForTab(
  tab: TerminalTab,
  ptyIdsByTabId: Record<string, string[] | undefined>,
  runtimeLivePtyIdsByWorktreeId: Record<string, string[] | undefined> | undefined,
  runtimeLivenessRequired: boolean
): string[] {
  const ids = new Set<string>()
  for (const id of runtimeLivePtyIdsByWorktreeId?.[tab.worktreeId] ?? []) {
    if (typeof id === 'string' && id.length > 0) {
      ids.add(toRuntimePtyId(id))
    }
  }
  if (!runtimeLivenessRequired) {
    for (const id of ptyIdsByTabId[tab.id] ?? []) {
      if (typeof id === 'string' && id.length > 0) {
        ids.add(toRuntimePtyId(id))
      }
    }
  }
  return [...ids]
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

function getEntryTabId(entry: AgentStatusEntry): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  return parsePaneKey(entry.paneKey)?.tabId ?? null
}

function getEligiblePane(args: {
  entry: AgentStatusEntry
  tab: TerminalTab
  layout: TerminalLayoutSnapshot | undefined
  livePtyIds: Set<string>
  sleepingAgentSessionsByPaneKey: AgentHibernationPlannerSnapshot['sleepingAgentSessionsByPaneKey']
  lastTerminalInputAtByPaneKey: AgentHibernationPlannerSnapshot['lastTerminalInputAtByPaneKey']
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
    mobileLockedPtyIds
  } = args
  if (entry.state !== 'done' || sleepingAgentSessionsByPaneKey[entry.paneKey]) {
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
  if (args.now - entry.updatedAt < args.idleMs) {
    return null
  }
  const inputAt = lastTerminalInputAtByPaneKey[entry.paneKey]
  if (typeof inputAt === 'number' && Number.isFinite(inputAt) && inputAt > entry.updatedAt) {
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
    providerSessionId: entry.providerSession.id,
    state: entry.state,
    updatedAt: entry.updatedAt,
    inputAt: typeof inputAt === 'number' && Number.isFinite(inputAt) ? inputAt : 0
  }
}

function signatureFor(worktreeId: string, panes: EligiblePane[]): string {
  const parts = panes
    .slice()
    .sort((a, b) => a.paneKey.localeCompare(b.paneKey))
    .map(
      (pane) =>
        `${pane.paneKey}:${pane.ptyId}:${pane.runtimePtyId}:${pane.providerSessionId}:${pane.state}:${pane.updatedAt}:${pane.inputAt}`
    )
  return `${worktreeId}|${parts.join('|')}`
}

function candidateIdFor(worktreeId: string, paneKey: string): string {
  return `${worktreeId}|${paneKey}`
}

function getAgentEntriesByTabId(
  agentStatusByPaneKey: AgentHibernationPlannerSnapshot['agentStatusByPaneKey']
): Map<string, AgentStatusEntry[]> {
  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (!entry) {
      continue
    }
    const tabId = getEntryTabId(entry)
    if (!tabId) {
      continue
    }
    const entries = entriesByTabId.get(tabId)
    if (entries) {
      entries.push(entry)
    } else {
      entriesByTabId.set(tabId, [entry])
    }
  }
  return entriesByTabId
}

export function planAgentHibernationCandidates(
  snapshot: AgentHibernationPlannerSnapshot
): AgentHibernationCandidate[] {
  if (snapshot.settings?.experimentalAgentHibernation !== true) {
    return []
  }
  const idleMs = getEffectiveAgentHibernationIdleMs(snapshot.settings.agentHibernationIdleMs)
  const mobileLockedPtyIds = new Set(snapshot.mobileLockedPtyIds.map(toRuntimePtyId))
  const foregroundWorktreeIds = new Set(snapshot.foregroundWorktreeIds)
  const runtimeLivenessRequiredWorktreeIds = new Set(
    snapshot.runtimeLivenessRequiredWorktreeIds ?? []
  )
  const agentEntriesByTabId = getAgentEntriesByTabId(snapshot.agentStatusByPaneKey)
  const candidates: AgentHibernationCandidate[] = []
  for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
    if (
      !worktreeId ||
      worktreeId === snapshot.activeWorktreeId ||
      foregroundWorktreeIds.has(worktreeId) ||
      tabs.length === 0
    ) {
      continue
    }
    if (
      runtimeLivenessRequiredWorktreeIds.has(worktreeId) &&
      !Object.prototype.hasOwnProperty.call(
        snapshot.runtimeLivePtyIdsByWorktreeId ?? {},
        worktreeId
      )
    ) {
      continue
    }
    for (const tab of tabs) {
      const tabLivePtyIds = getLivePtyIdsForTab(
        tab,
        snapshot.ptyIdsByTabId,
        snapshot.runtimeLivePtyIdsByWorktreeId,
        runtimeLivenessRequiredWorktreeIds.has(worktreeId)
      )
      if (tabLivePtyIds.length === 0) {
        continue
      }
      const layout = snapshot.terminalLayoutsByTabId[tab.id]
      for (const entry of agentEntriesByTabId.get(tab.id) ?? []) {
        const eligible = getEligiblePane({
          entry,
          tab,
          layout,
          livePtyIds: new Set(tabLivePtyIds),
          sleepingAgentSessionsByPaneKey: snapshot.sleepingAgentSessionsByPaneKey,
          lastTerminalInputAtByPaneKey: snapshot.lastTerminalInputAtByPaneKey,
          mobileLockedPtyIds,
          now: snapshot.now,
          idleMs
        })
        if (eligible) {
          candidates.push({
            id: candidateIdFor(worktreeId, eligible.paneKey),
            worktreeId,
            paneKey: eligible.paneKey,
            tabId: eligible.tabId,
            leafId: eligible.leafId,
            paneKeys: [eligible.paneKey],
            targetPtyIds: [eligible.ptyId],
            expectedRuntimePtyIds: [eligible.runtimePtyId],
            signature: signatureFor(worktreeId, [eligible])
          })
        }
      }
    }
  }
  return candidates.sort(
    (a, b) => a.worktreeId.localeCompare(b.worktreeId) || a.paneKey.localeCompare(b.paneKey)
  )
}

export function confirmAgentHibernationCandidates(
  previous: AgentHibernationConfirmationState,
  candidates: AgentHibernationCandidate[]
): AgentHibernationPlan {
  const confirmationState: AgentHibernationConfirmationState = {}
  const confirmed: AgentHibernationCandidate[] = []
  for (const candidate of candidates) {
    confirmationState[candidate.id] = candidate.signature
    if (previous[candidate.id] === candidate.signature) {
      confirmed.push(candidate)
    }
  }
  return { candidates: confirmed, confirmationState }
}
