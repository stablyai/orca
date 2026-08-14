import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { DashboardAgentRow } from './useDashboardData'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

// Why: when an agent finishes or its terminal closes, the store cleans up the
// explicit status entry and the agent vanishes from the live status set.
// Retaining the last-known "done" snapshot in the store lets the inline
// per-card agents list render the done row until the user dismisses it, rather
// than having the row wink out the moment the terminal process exits.

type RetainedAgentSnapshot = Map<string, { row: DashboardAgentRow; worktreeId: string }>

type RetainedAgentsSyncInputs = {
  repos: readonly Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  folderWorkspaces: readonly FolderWorkspace[]
  tabsByWorktree: Record<string, TerminalTab[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
}

type RetainedAgentsSyncSnapshotInputs = RetainedAgentsSyncInputs & {
  now: number
}

function paneKeyTabId(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.tabId ?? null
}

function buildLiveTabIndex(args: {
  repos: readonly Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  folderWorkspaces: readonly FolderWorkspace[]
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

  for (const folderWorkspace of args.folderWorkspaces) {
    if (folderWorkspace.isArchived) {
      continue
    }
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    existingWorktreeIds.add(workspaceKey)
    for (const tab of args.tabsByWorktree[workspaceKey] ?? []) {
      tabIndex.set(tab.id, { tab, worktreeId: workspaceKey })
    }
  }

  return { existingWorktreeIds, tabIndex }
}

function agentStartedAt(entry: AgentStatusEntry): number {
  return entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
}

export function buildRetainedAgentsSyncSnapshot(args: RetainedAgentsSyncSnapshotInputs): {
  currentAgents: RetainedAgentSnapshot
  existingWorktreeIds: Set<string>
  tabIndex: Map<string, { tab: TerminalTab; worktreeId: string }>
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

  return { currentAgents, existingWorktreeIds, tabIndex }
}

export function useRetainedAgentsSync(): void {
  const retainAgents = useAppStore((s) => s.retainAgents)
  const pruneRetainedAgents = useAppStore((s) => s.pruneRetainedAgents)
  const clearRetentionSuppressedPaneKeys = useAppStore((s) => s.clearRetentionSuppressedPaneKeys)
  const [repos, worktreesByRepo, folderWorkspaces, tabsByWorktree, agentStatusEpoch] = useAppStore(
    useShallow(
      (s) =>
        [
          s.repos,
          s.worktreesByRepo,
          s.folderWorkspaces,
          s.tabsByWorktree,
          s.agentStatusEpoch
        ] as const
    )
  )
  const prevAgentsRef = useRef<RetainedAgentSnapshot>(new Map())

  useEffect(() => {
    const state = useAppStore.getState()
    const { currentAgents, existingWorktreeIds, tabIndex } = buildRetainedAgentsSyncSnapshot({
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      tabsByWorktree: state.tabsByWorktree,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      now: Date.now()
    })

    // Why: read retention state via getState() after the cheap ref/epoch gate
    // fires. Building the full retention snapshot scans all agents, so do it
    // only when live identity/state/freshness/final-done data or worktree
    // membership changes. Subscribing to retainedAgentsByPaneKey would create
    // a feedback loop because this effect calls retainAgents.
    const { retainedAgentsByPaneKey: retainedNow, retentionSuppressedPaneKeys } = state
    const { toRetain, consumedSuppressedPaneKeys } = collectRetainedAgentsOnDisappear({
      previousAgents: prevAgentsRef.current,
      currentAgents,
      retainedAgentsByPaneKey: retainedNow,
      retentionSuppressedPaneKeys,
      recentlyClosedAgentStatusTabIds: state.recentlyClosedAgentStatusTabIds,
      recentlyRetiredAgentStatusPaneKeys: state.recentlyRetiredAgentStatusPaneKeys,
      tabIndex
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
  }, [
    repos,
    worktreesByRepo,
    folderWorkspaces,
    tabsByWorktree,
    agentStatusEpoch,
    retainAgents,
    pruneRetainedAgents,
    clearRetentionSuppressedPaneKeys
  ])
}

function sameAgentRun(
  previous: { row: DashboardAgentRow },
  current: { row: DashboardAgentRow }
): boolean {
  // Why: resume identity arrives on its own IPC event, so one side can be stamped
  // while the other is not. Only a session present on BOTH sides is decisive.
  const previousSession = previous.row.entry.providerSession
  const currentSession = current.row.entry.providerSession
  if (previousSession && currentSession) {
    return previousSession.key === currentSession.key && previousSession.id === currentSession.id
  }
  // Why: terminalHandle identifies the TERMINAL, not the run — a later agent started
  // in the same pty inherits it, so it only corroborates a matching run identity.
  // It is absent for ordinary local PTY agents, so it cannot be required.
  const previousHandle = previous.row.entry.terminalHandle
  const currentHandle = current.row.entry.terminalHandle
  if (previousHandle && currentHandle && previousHandle !== currentHandle) {
    return false
  }
  return (
    previous.row.startedAt === current.row.startedAt &&
    previous.row.agentType === current.row.agentType
  )
}

export function collectRetainedAgentsOnDisappear(args: {
  previousAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  currentAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  retentionSuppressedPaneKeys: Record<string, true>
  recentlyClosedAgentStatusTabIds: Record<string, true>
  recentlyRetiredAgentStatusPaneKeys: Record<string, true>
  /** Live tabs by id; supplies the real destination tab when a pane key transferred. */
  tabIndex?: Map<string, { tab: TerminalTab }>
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
    const transferredPaneKey = resolveAgentPaneAuthorityKey(paneKey)
    const migrated =
      transferredPaneKey === paneKey ? undefined : args.currentAgents.get(transferredPaneKey)
    if (migrated && sameAgentRun(prev, migrated)) {
      continue
    }
    // Why: a different run already occupies the transferred key, so this row keeps
    // its own key rather than colliding with the live one.
    const ownerPaneKey = migrated ? paneKey : transferredPaneKey
    if (
      args.recentlyRetiredAgentStatusPaneKeys[paneKey] ||
      args.recentlyRetiredAgentStatusPaneKeys[ownerPaneKey]
    ) {
      continue
    }
    // Why: skip only when the retained snapshot is for the SAME (or newer) run.
    // A reused paneKey (same tab+pane, fresh agent start after a prior run was
    // retained) produces a newer startedAt — we must overwrite so stale
    // completion data doesn't linger forever for the reused pane.
    const alreadyRetained = args.retainedAgentsByPaneKey[ownerPaneKey]
    if (alreadyRetained && alreadyRetained.startedAt >= prev.row.startedAt) {
      continue
    }
    const suppressedPaneKey = args.retentionSuppressedPaneKeys[paneKey]
      ? paneKey
      : args.retentionSuppressedPaneKeys[ownerPaneKey]
        ? ownerPaneKey
        : null
    if (suppressedPaneKey) {
      consumedSuppressedPaneKeys.push(suppressedPaneKey)
      continue
    }
    // Why: the row must land on the surface that owns the pane now — a detach
    // followed by a PTY exit before the next sync would otherwise retain it
    // under the abandoned source tab.
    const ownerTabId = paneKeyTabId(ownerPaneKey) ?? prev.row.tab.id
    // Why: prefer the real destination tab — reusing the source tab's title and
    // launchAgent under a different id would mislabel the retained row.
    const ownerTab =
      ownerTabId === prev.row.tab.id
        ? prev.row.tab
        : (args.tabIndex?.get(ownerTabId)?.tab ?? { ...prev.row.tab, id: ownerTabId })
    // Why: PTY exit can remove the live row before closeTab plants a suppressor;
    // the closed-tab marker prevents re-retention.
    if (args.recentlyClosedAgentStatusTabIds[ownerTabId]) {
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
      entry:
        ownerPaneKey === paneKey
          ? prev.row.entry
          : { ...prev.row.entry, paneKey: ownerPaneKey, tabId: ownerTabId },
      worktreeId: prev.worktreeId,
      tab: ownerTab,
      agentType: prev.row.agentType,
      startedAt: prev.row.startedAt
    })
  }

  return { toRetain, consumedSuppressedPaneKeys }
}
