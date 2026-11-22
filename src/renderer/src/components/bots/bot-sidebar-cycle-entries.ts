import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botLineLanes } from '../../../../shared/bots/bot-line-lanes'
import type { BotSidebarEntry } from '../../../../shared/bots/bot-sidebar-entries'
import { botListsUnderRow } from '../../../../shared/bots/bot-sidebar-tree'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  getLineageGroupKey,
  getWorktreeLineageGroupKey
} from '../../../../shared/sidebar-list/sections/group-keys'
import { botWorkerLineRowKey } from '../../../../shared/sidebar-list/sidebar-reveal-target'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RenderedWorkspaceRow } from '@/components/sidebar/worktree-list/navigation/worktree-sidebar-row-preference'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'

type Entry = BotSidebarEntry<Bot, BotGroup, FolderWorkspace>

let visibleEntries: readonly Entry[] = []
const workersByEntryKey = new Map<string, readonly Worktree[]>()

export function setBotSidebarCycleEntries(entries: readonly Entry[]): void {
  visibleEntries = entries
  const liveKeys = new Set(entries.map((entry) => entry.id))
  for (const key of workersByEntryKey.keys()) {
    if (!liveKeys.has(key)) {
      workersByEntryKey.delete(key)
    }
  }
}

export function setBotSidebarCycleWorkers(entryKey: string, worktrees: readonly Worktree[]): void {
  if (worktrees.length === 0) {
    workersByEntryKey.delete(entryKey)
  } else {
    workersByEntryKey.set(entryKey, worktrees)
  }
}

/** Visible worker roots followed by their unfolded lineage lanes, matching AttachedWorktreeCards. */
export function collectVisibleBotWorkerWorktrees(
  roots: readonly Worktree[],
  lineageChildrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>,
  collapsedGroups: ReadonlySet<string>
): Worktree[] {
  const visible: Worktree[] = []
  for (const root of roots) {
    visible.push(root)
    if (collapsedGroups.has(getWorktreeLineageGroupKey(root))) {
      continue
    }
    visible.push(
      ...botLineLanes(
        root,
        (line) => lineageChildrenByParentIdentity.get(getWorktreeHostIdentity(line)) ?? [],
        getWorktreeHostIdentity
      )
    )
  }
  return visible
}

export function buildBotSidebarCycleRows<B extends { hostId: ExecutionHostId }>(args: {
  entries: readonly BotSidebarEntry<B, BotGroup, FolderWorkspace>[]
  workersByEntryKey: ReadonlyMap<string, readonly Worktree[]>
  collapsedGroups: ReadonlySet<string>
  repoMap: ReadonlyMap<string, Repo>
  isHostOffline: (hostId: ExecutionHostId) => boolean
}): RenderedWorkspaceRow[] {
  const { entries, workersByEntryKey: workersMap, collapsedGroups, repoMap, isHostOffline } = args
  const rows: RenderedWorkspaceRow[] = []

  for (const entry of entries) {
    const hostId = entry.kind === 'bot' ? entry.bot.hostId : entry.group.hostId
    const homeWorktree = getFolderWorkspaceWorktree(entry.home, {
      hostId,
      connectionId: entry.home.connectionId ?? null
    })
    rows.push({
      section: 'bots',
      worktree: homeWorktree,
      repo: undefined,
      rowKey: composeWorktreeHostIdentity(hostId, homeWorktree.id),
      ...(entry.kind === 'group' ? { botGroup: entry.group } : {})
    })

    if (entry.kind !== 'bot') {
      continue
    }
    const folded = collapsedGroups.has(getLineageGroupKey(folderWorkspaceKey(entry.home.id)))
    if (!botListsUnderRow({ folded, hostDown: isHostOffline(entry.bot.hostId) })) {
      continue
    }
    for (const worker of workersMap.get(entry.id) ?? []) {
      rows.push({
        section: 'bots',
        worktree: worker,
        repo: repoMap.get(worker.repoId),
        rowKey: botWorkerLineRowKey(getWorktreeHostIdentity(worker))
      })
    }
  }

  return rows
}

export function readBotSidebarCycleRows(
  collapsedGroups: ReadonlySet<string>,
  repoMap: ReadonlyMap<string, Repo>
): RenderedWorkspaceRow[] {
  if (visibleEntries.length === 0) {
    return []
  }
  return buildBotSidebarCycleRows({
    entries: visibleEntries,
    workersByEntryKey,
    collapsedGroups,
    repoMap,
    isHostOffline: (hostId) => readBotHostState(hostId) === 'offline'
  })
}
