import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  getEligiblePane,
  getEntryTabId,
  toRuntimePtyId,
  type EligiblePane
} from './agent-hibernation-pane-eligibility'
import type { AgentHibernationPlannerSnapshot } from './agent-hibernation-planner-snapshot'

export type { AgentHibernationPlannerSnapshot } from './agent-hibernation-planner-snapshot'

export const DEFAULT_AGENT_HIBERNATION_IDLE_MS = 30 * 60 * 1000
export const MIN_AGENT_HIBERNATION_IDLE_MS = 60 * 1000
export const MAX_AGENT_HIBERNATION_IDLE_MS = 24 * 60 * 60 * 1000

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

function signatureFor(worktreeId: string, panes: EligiblePane[]): string {
  const parts = panes
    .slice()
    .sort((a, b) => a.paneKey.localeCompare(b.paneKey))
    .map(
      (pane) =>
        // Ignore repaint-driven updatedAt so consecutive ticks can match; compare agent kind and full resume identity instead.
        `${pane.paneKey}:${pane.ptyId}:${pane.runtimePtyId}:${pane.agentType}:${pane.providerSessionKey}:${pane.providerSessionId}:${pane.providerTranscriptPath}:${pane.state}:${pane.stateStartedAt}:${pane.effectiveIdleStart}:${pane.inputAt}`
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
  const foregroundTerminalTabIds = new Set(snapshot.foregroundTerminalTabIds)
  const runtimeLivenessRequiredWorktreeIds = new Set(
    snapshot.runtimeLivenessRequiredWorktreeIds ?? []
  )
  const agentEntriesByTabId = getAgentEntriesByTabId(snapshot.agentStatusByPaneKey)
  const candidates: AgentHibernationCandidate[] = []
  for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
    // Protect the foreground tab and recently left tabs individually; excluding the entire active worktree prevents reclaim there (#16211).
    if (!worktreeId || tabs.length === 0) {
      continue
    }
    // Floating terminals stay running when idle; the user must not need a hibernation resume.
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      continue
    }
    if (
      runtimeLivenessRequiredWorktreeIds.has(worktreeId) &&
      !Object.hasOwn(snapshot.runtimeLivePtyIdsByWorktreeId ?? {}, worktreeId)
    ) {
      continue
    }
    for (const tab of tabs) {
      if (foregroundTerminalTabIds.has(tab.id)) {
        continue
      }
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
          foregroundTerminalLastSeenAtByTabId: snapshot.foregroundTerminalLastSeenAtByTabId,
          ptyBindingFirstSeenAtByPaneKey: snapshot.ptyBindingFirstSeenAtByPaneKey ?? {},
          boundaryResolvedAtByPaneKey: snapshot.boundaryResolvedAtByPaneKey ?? {},
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
