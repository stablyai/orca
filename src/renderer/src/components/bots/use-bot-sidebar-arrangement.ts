import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { useWorktreeActivityStatuses } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-statuses'
import { useBotWorkerWorkspaceStatuses } from './use-bot-worker-statuses'
import { useOrderHeldWhileEngaged } from '@/components/sidebar/worktree-list/listing/use-order-hold'
import { getFolderWorkspaceChildWorktrees } from '../../../../shared/folder-workspace-child-worktrees'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import { botStatusNeedsAttention } from '../../../../shared/bots/bot-collapsed-preview'
import { arrangeBotSidebarEntries } from '../../../../shared/bots/bot-sidebar-view'
import type { BotSidebarEntry } from '../../../../shared/bots/bot-sidebar-entries'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'

/** Each home's own status and its workers' (their root workspaces), in `homes` order. */
export function useBotHomeWorkers(homes: readonly FolderWorkspace[]): {
  own: WorktreeStatus
  workers: Worktree[]
  workerStatuses: WorktreeStatus[]
}[] {
  const childrenByParent = useAppStoreWithHostStatuses(selectSidebarChildrenByParentIdentity)
  const workersByHome = useMemo(
    () =>
      homes.map(
        (home) =>
          getFolderWorkspaceChildWorktrees(getFolderWorkspaceHostIdentity(home), childrenByParent)
            .childWorktrees
      ),
    [homes, childrenByParent]
  )
  const homeIds = useMemo(() => homes.map((home) => folderWorkspaceKey(home.id)), [homes])
  const workerIds = useMemo(
    () => workersByHome.flatMap((workers) => workers.map((worker) => worker.id)),
    [workersByHome]
  )
  const own = useWorktreeActivityStatuses(homeIds)
  const workerStatuses = useBotWorkerWorkspaceStatuses(workerIds)
  return homes.map((home, index) => ({
    own: own.get(folderWorkspaceKey(home.id)) ?? 'inactive',
    workers: workersByHome[index]!,
    workerStatuses: workersByHome[index]!.map(
      (worker) => workerStatuses.get(worker.id) ?? 'inactive'
    )
  }))
}

type Entry = BotSidebarEntry<Bot, BotGroup, FolderWorkspace>

/** The Bots section's entries as Bot options list them, held still while the pointer is on the list. */
export function useBotSidebarArrangement(entries: readonly Entry[]): Entry[] {
  const view = useAppStore((s) => s.botSidebarView)
  const homes = useMemo(() => entries.map((entry) => entry.home), [entries])
  const homeWorkers = useBotHomeWorkers(homes)
  const ranked = arrangeBotSidebarEntries(
    entries.map((entry, index) => ({ ...entry, index, isPinned: entry.home.isPinned })),
    view,
    ({ index, ...entry }) => {
      const { own, workers, workerStatuses } = homeWorkers[index]!
      return {
        needsYou: [own, ...workerStatuses].some(botStatusNeedsAttention),
        activityAt: Math.max(
          entry.home.lastActivityAt,
          entry.kind === 'group' ? (entry.group.latest?.at ?? 0) : 0,
          ...workers.map((worker) => worker.lastActivityAt)
        )
      }
    }
  )
  // Hold pinned and unpinned lists apart so a pin toggle moves its row at once while engaged.
  const pinnedIds = ranked.filter((entry) => entry.isPinned).map(({ id }) => id)
  const unpinnedIds = ranked.filter((entry) => !entry.isPinned).map(({ id }) => id)
  const shownPinnedIds = useOrderHeldWhileEngaged(pinnedIds, view.sortBy, 'bots')
  const shownUnpinnedIds = useOrderHeldWhileEngaged(unpinnedIds, view.sortBy, 'bots')
  return useMemo(() => {
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    return [...shownPinnedIds, ...shownUnpinnedIds].flatMap((id) => byId.get(id) ?? [])
  }, [entries, shownPinnedIds, shownUnpinnedIds])
}
