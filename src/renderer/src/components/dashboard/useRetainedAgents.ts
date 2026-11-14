import { agentEntrySessionStartedAt } from '../../../../shared/agent-session/lifecycle/agent-session-start-time'
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  isAgentStatusFresh,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { DashboardAgentRow } from './useDashboardData'
import type {
  AgentRetentionSuppression,
  RetainedAgentEntry
} from '@/store/slices/agent-status/agent-status-contract'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-status/agent-pane-authority'

import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { agentTurnEndedOnPurpose } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'

import {
  createWorktreeTabBucketProjection,
  type WorktreeTabBucketProjection
} from '@/lib/workspace/tabs/worktree-tab-bucket-projection'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

// Keep finished snapshots after live status cleanup so closed terminals’ rows remain until user dismissal.

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
export function createRetainedAgentsTabTopologyProjection(
  onInspectBucket?: (worktreeId: string) => void
) {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) =>
      previousTab.id === nextTab.id && previousTab.worktreeId === nextTab.worktreeId,
    onInspectBucket
  })
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
  return agentEntrySessionStartedAt(entry)
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
    const isFresh = isAgentStatusFresh(entry, args.now, AGENT_STATUS_STALE_AFTER_MS)
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
  const tabTopologyProjectionRef = useRef<WorktreeTabBucketProjection<
    TerminalTab,
    TerminalTab
  > | null>(null)
  if (tabTopologyProjectionRef.current == null) {
    tabTopologyProjectionRef.current = createRetainedAgentsTabTopologyProjection()
  }
  const retainAgents = useAppStore((s) => s.retainAgents)
  const pruneRetainedAgents = useAppStore((s) => s.pruneRetainedAgents)
  const clearRetentionSuppressedPaneKeys = useAppStore((s) => s.clearRetentionSuppressedPaneKeys)
  const [repos, worktreesByRepo, folderWorkspaces, tabTopology, agentStatusEpoch] = useAppStore(
    useShallow(
      (s) =>
        [
          s.repos,
          selectWorktreesByRepo(s),
          selectFolderWorkspaces(s),
          tabTopologyProjectionRef.current!.project(s.tabsByWorktree),
          s.agentStatusEpoch
        ] as const
    )
  )
  const prevAgentsRef = useRef<RetainedAgentSnapshot>(new Map())

  useEffect(() => {
    const state = useAppStore.getState()
    const { currentAgents, existingWorktreeIds, tabIndex } = buildRetainedAgentsSyncSnapshot({
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state),
      tabsByWorktree: state.tabsByWorktree,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      now: Date.now()
    })

    // Read current retention only after topology/epoch invalidation; title-only writes must not trigger a full agent scan.
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
    // Retain vanished agents atomically so subscribers cannot observe intermediate maps or receive N updates per teardown.
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
    tabTopology,
    agentStatusEpoch,
    retainAgents,
    pruneRetainedAgents,
    clearRetentionSuppressedPaneKeys
  ])
}

/** Match snapshots despite delayed provider identity, keeping replacement runs in the same pane distinct. */
function sameAgentRun(
  previous: Pick<DashboardAgentRow, 'entry' | 'startedAt' | 'agentType'>,
  current: Pick<DashboardAgentRow, 'entry' | 'startedAt' | 'agentType'>
): boolean {
  // Resume identity arrives independently; compare sessions only when both sides have one.
  const previousSession = previous.entry.providerSession
  const currentSession = current.entry.providerSession
  if (previousSession && currentSession) {
    return previousSession.key === currentSession.key && previousSession.id === currentSession.id
  }
  // Terminal handles can span runs and are absent locally; use them only to corroborate run identity.
  const previousHandle = previous.entry.terminalHandle
  const currentHandle = current.entry.terminalHandle
  if (previousHandle && currentHandle && previousHandle !== currentHandle) {
    return false
  }
  return previous.startedAt === current.startedAt && previous.agentType === current.agentType
}

/** Retain eligible disappeared runs and consume exit suppressors without discarding a replacement run's result. */
export function collectRetainedAgentsOnDisappear(args: {
  previousAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  currentAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  retentionSuppressedPaneKeys: Record<string, AgentRetentionSuppression>
  recentlyClosedAgentStatusTabIds: Record<string, true>
  recentlyRetiredAgentStatusPaneKeys: Record<string, true | string>
  /** Live tabs by id; supplies the real destination tab when a pane key transferred. */
  tabIndex?: Map<string, { tab: TerminalTab }>
}): {
  toRetain: RetainedAgentEntry[]
  consumedSuppressedPaneKeys: string[]
} {
  const toRetain: RetainedAgentEntry[] = []
  const consumedSuppressedPaneKeys = new Set<string>()

  for (const [paneKey, suppression] of Object.entries(args.retentionSuppressedPaneKeys)) {
    const current = args.currentAgents.get(paneKey)
    if (
      suppression !== true &&
      current &&
      (!suppression.run || !sameAgentRun(suppression.run, current.row))
    ) {
      consumedSuppressedPaneKeys.add(paneKey)
    }
  }

  for (const [paneKey, prev] of args.previousAgents) {
    if (args.currentAgents.has(paneKey)) {
      continue
    }
    const transferredPaneKey = resolveAgentPaneAuthorityKey(paneKey)
    const migrated =
      transferredPaneKey === paneKey ? undefined : args.currentAgents.get(transferredPaneKey)
    if (migrated && sameAgentRun(prev.row, migrated.row)) {
      continue
    }
    // A different live run owns the transferred key; retain this row under its own key instead.
    const ownerPaneKey = migrated ? paneKey : transferredPaneKey
    if (
      args.recentlyRetiredAgentStatusPaneKeys[paneKey] ||
      args.recentlyRetiredAgentStatusPaneKeys[ownerPaneKey]
    ) {
      continue
    }
    // Skip only same/newer retained runs; reused pane keys must replace older completion snapshots.
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
      const suppression = args.retentionSuppressedPaneKeys[suppressedPaneKey]
      consumedSuppressedPaneKeys.add(suppressedPaneKey)
      if (suppression === true || !suppression.run || sameAgentRun(suppression.run, prev.row)) {
        continue
      }
    }
    // Retain under the current owner after pane transfer, including PTY exits before the next sync.
    const ownerTabId = paneKeyTabId(ownerPaneKey) ?? prev.row.tab.id
    // Use the real destination tab’s title/launch identity rather than relabeling the source tab.
    const ownerTab =
      args.tabIndex?.get(ownerTabId)?.tab ??
      (ownerTabId === prev.row.tab.id ? prev.row.tab : { ...prev.row.tab, id: ownerTabId })
    // Why: PTY exit can remove the live row before closeTab plants a suppressor;
    // the closed-tab marker prevents re-retention.
    if (args.recentlyClosedAgentStatusTabIds[ownerTabId]) {
      continue
    }
    // Retain finished/failed outcomes unless deliberately stopped; explicit teardown suppressors prevent stale done rows from resurfacing.
    const lastState = prev.row.state
    if (lastState !== 'done' || agentTurnEndedOnPurpose(prev.row.entry)) {
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

  return { toRetain, consumedSuppressedPaneKeys: [...consumedSuppressedPaneKeys] }
}
