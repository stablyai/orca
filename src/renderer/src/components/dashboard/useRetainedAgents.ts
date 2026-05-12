import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { type DashboardAgentRow } from './useDashboardData'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

// Why: when an agent finishes or its terminal closes, the store cleans up the
// explicit status entry and the agent vanishes from the live status set.
// Retaining the last-known "done" snapshot in the store lets the inline
// per-card agents list render the done row until the user dismisses it, rather
// than having the row wink out the moment the terminal process exits.

type RetainedAgentSnapshot = Map<string, { row: DashboardAgentRow; worktreeId: string }>

type RetainedAgentsSyncInputs = {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  agentStatusEpoch?: number
}

type RetainedAgentsSyncSnapshotInputs = RetainedAgentsSyncInputs & {
  now: number
}

function paneKeyTabId(paneKey: string): string | null {
  const colonIndex = paneKey.indexOf(':')
  if (colonIndex <= 0) {
    return null
  }
  return paneKey.slice(0, colonIndex)
}

function buildLiveTabIndex(args: {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
}): {
  existingWorktreeIds: Set<string>
  tabIndex: Map<string, { tab: TerminalTab; worktreeId: string }>
} {
  const existingWorktreeIds = new Set<string>()
  const tabIndex = new Map<string, { tab: TerminalTab; worktreeId: string }>()

  for (const repo of args.repos) {
    const worktrees = args.worktreesByRepo[repo.id] ?? []
    for (const worktree of worktrees) {
      if (worktree.isArchived) {
        continue
      }
      existingWorktreeIds.add(worktree.id)
      const tabs = args.tabsByWorktree[worktree.id] ?? []
      for (const tab of tabs) {
        tabIndex.set(tab.id, { tab, worktreeId: worktree.id })
      }
    }
  }

  return { existingWorktreeIds, tabIndex }
}

function agentStartedAt(entry: AgentStatusEntry): number {
  return entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
}

export function buildRetainedAgentsSyncSignature(args: RetainedAgentsSyncInputs): string {
  const { existingWorktreeIds, tabIndex } = buildLiveTabIndex(args)
  const worktreeParts = [...existingWorktreeIds].sort()
  const tabParts = [...tabIndex.entries()]
    .map(([tabId, owner]) => `${owner.worktreeId}:${tabId}`)
    .sort()
  const agentParts: string[] = []

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    const tabId = paneKeyTabId(paneKey)
    if (!tabId) {
      continue
    }
    const owner = tabIndex.get(tabId)
    if (!owner) {
      continue
    }
    // Why: working/blocked/waiting pings can update prompt/tool text dozens of
    // times per second; retention only cares about identity, state, freshness,
    // and final done payloads.
    const doneUpdatedAt = entry.state === 'done' ? entry.updatedAt : ''
    agentParts.push(
      [
        owner.worktreeId,
        paneKey,
        entry.state,
        entry.interrupted === true ? 'interrupted' : '',
        agentStartedAt(entry),
        doneUpdatedAt
      ].join(':')
    )
  }

  agentParts.sort()
  return [
    `epoch:${args.agentStatusEpoch ?? 0}`,
    `worktrees:${worktreeParts.join(',')}`,
    `tabs:${tabParts.join(',')}`,
    `agents:${agentParts.join(',')}`
  ].join('|')
}

export function buildRetainedAgentsSyncSnapshot(args: RetainedAgentsSyncSnapshotInputs): {
  currentAgents: RetainedAgentSnapshot
  existingWorktreeIds: Set<string>
} {
  const { existingWorktreeIds, tabIndex } = buildLiveTabIndex(args)
  const currentAgents: RetainedAgentSnapshot = new Map()

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    const tabId = paneKeyTabId(paneKey)
    if (!tabId) {
      continue
    }
    const owner = tabIndex.get(tabId)
    if (!owner) {
      continue
    }
    const isFresh = isExplicitAgentStatusFresh(entry, args.now, AGENT_STATUS_STALE_AFTER_MS)
    const shouldDecay =
      !isFresh &&
      (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
    currentAgents.set(paneKey, {
      row: {
        paneKey,
        entry,
        tab: owner.tab,
        agentType: entry.agentType ?? 'unknown',
        state: shouldDecay ? 'idle' : entry.state,
        startedAt: agentStartedAt(entry)
      },
      worktreeId: owner.worktreeId
    })
  }

  return { currentAgents, existingWorktreeIds }
}

export function useRetainedAgentsSync(): void {
  const retainAgents = useAppStore((s) => s.retainAgents)
  const pruneRetainedAgents = useAppStore((s) => s.pruneRetainedAgents)
  const clearRetentionSuppressedPaneKeys = useAppStore((s) => s.clearRetentionSuppressedPaneKeys)
  const retentionSignature = useAppStore((s) =>
    buildRetainedAgentsSyncSignature({
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      tabsByWorktree: s.tabsByWorktree,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch
    })
  )
  const prevAgentsRef = useRef<RetainedAgentSnapshot>(new Map())

  useEffect(() => {
    const state = useAppStore.getState()
    const { currentAgents, existingWorktreeIds } = buildRetainedAgentsSyncSnapshot({
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      tabsByWorktree: state.tabsByWorktree,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      agentStatusEpoch: state.agentStatusEpoch,
      now: Date.now()
    })

    // Why: read retention state via getState() instead of subscribing. This
    // effect's driving input is the retention signature — retention decisions
    // only need to happen when live identity/state/freshness or worktree
    // membership changes. Subscribing to retainedAgentsByPaneKey would create
    // a feedback loop because this effect calls retainAgents.
    const { retainedAgentsByPaneKey: retainedNow, retentionSuppressedPaneKeys } = state
    const { toRetain, consumedSuppressedPaneKeys } = collectRetainedAgentsOnDisappear({
      previousAgents: prevAgentsRef.current,
      currentAgents,
      retainedAgentsByPaneKey: retainedNow,
      retentionSuppressedPaneKeys
    })
    // Why: batch retention into a single store mutation. Looping retainAgent
    // would trigger N set(...) calls and N subscriber notifications when
    // several agents vanish in the same frame (e.g. tab close, worktree
    // teardown), exposing intermediate maps to consumers mid-loop. A single
    // atomic update keeps the inline agents list visually stable.
    retainAgents(toRetain)

    prevAgentsRef.current = currentAgents
    pruneRetainedAgents(existingWorktreeIds)
    if (consumedSuppressedPaneKeys.length > 0) {
      clearRetentionSuppressedPaneKeys(consumedSuppressedPaneKeys)
    }
  }, [retentionSignature, retainAgents, pruneRetainedAgents, clearRetentionSuppressedPaneKeys])
}

export function collectRetainedAgentsOnDisappear(args: {
  previousAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  currentAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  retentionSuppressedPaneKeys: Record<string, true>
}): {
  toRetain: RetainedAgentEntry[]
  consumedSuppressedPaneKeys: string[]
} {
  const toRetain: RetainedAgentEntry[] = []
  const consumedSuppressedPaneKeys: string[] = []

  for (const [paneKey, prev] of args.previousAgents) {
    if (args.currentAgents.has(paneKey)) {
      continue
    }
    // Why: skip only when the retained snapshot is for the SAME (or newer) run.
    // A reused paneKey (same tab+pane, fresh agent start after a prior run was
    // retained) produces a newer startedAt — we must overwrite so stale
    // completion data doesn't linger forever for the reused pane.
    const alreadyRetained = args.retainedAgentsByPaneKey[paneKey]
    if (alreadyRetained && alreadyRetained.startedAt >= prev.row.startedAt) {
      continue
    }
    if (args.retentionSuppressedPaneKeys[paneKey]) {
      consumedSuppressedPaneKeys.push(paneKey)
      continue
    }
    // Why: only keep a sticky snapshot when the agent finished cleanly
    // (state === 'done' and not interrupted). Explicit teardown paths mark
    // pane keys as suppression candidates, so a close/quit/crash cannot
    // resurrect a stale `done` row on the next sync.
    const lastState = prev.row.state
    const wasInterrupted = prev.row.entry.interrupted === true
    if (lastState !== 'done' || wasInterrupted) {
      continue
    }
    toRetain.push({
      entry: prev.row.entry,
      worktreeId: prev.worktreeId,
      tab: prev.row.tab,
      agentType: prev.row.agentType,
      startedAt: prev.row.startedAt
    })
  }

  return { toRetain, consumedSuppressedPaneKeys }
}
