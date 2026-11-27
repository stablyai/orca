import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { useWorktreeActivityStatuses } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-statuses'
import { useBotWorkerWorkspaceStatuses } from './use-bot-worker-statuses'
import type { ProjectGroupHeaderDragItem } from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
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
export function useBotSidebarArrangement(savedEntries: readonly Entry[]): {
  entries: Entry[]
  eligibleEntries: readonly Entry[]
  fullSidebarOrder: readonly string[] | undefined
  dragItemById: ReadonlyMap<string, ProjectGroupHeaderDragItem>
} {
  const view = useAppStore((s) => s.botSidebarView)
  const showHiddenBots = useAppStore((s) => s.showHiddenBots)
  const hiddenBotSidebarKeys = useAppStore((s) => s.hiddenBotSidebarKeys)
  const eligibleEntries = useMemo(() => {
    if (showHiddenBots || hiddenBotSidebarKeys.length === 0) {
      return savedEntries
    }
    const hiddenKeys = new Set(hiddenBotSidebarKeys)
    return savedEntries.filter((entry) => entry.kind !== 'bot' || !hiddenKeys.has(entry.id))
  }, [savedEntries, showHiddenBots, hiddenBotSidebarKeys])
  const homes = useMemo(() => eligibleEntries.map((entry) => entry.home), [eligibleEntries])
  const homeWorkers = useBotHomeWorkers(homes)
  const ranked = arrangeBotSidebarEntries(
    eligibleEntries.map((entry, index) => ({ ...entry, index })),
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
  ).map(({ id }) => id)
  const shownIds = useOrderHeldWhileEngaged(ranked, view.sortBy, 'bots')
  const entries = useMemo(() => {
    const byId = new Map(eligibleEntries.map((entry) => [entry.id, entry]))
    return shownIds.flatMap((id) => byId.get(id) ?? [])
  }, [eligibleEntries, shownIds])
  const hasHiddenBots = eligibleEntries.length !== savedEntries.length
  const fullSidebarOrder = useMemo(
    () => (hasHiddenBots ? savedEntries.map(({ id }) => id) : undefined),
    [hasHiddenBots, savedEntries]
  )
  const dragItemById = useMemo(
    () =>
      new Map<string, ProjectGroupHeaderDragItem>(
        // An entry never placed takes no order, so the first drop writes one for every entry.
        savedEntries.map((entry) => {
          const owner = entry.kind === 'bot' ? entry.bot : entry.group
          return [
            entry.id,
            {
              parentGroupId: null,
              tabOrder: owner.sidebarOrder ?? -1,
              canSaveOrder: hasHiddenBots
                ? () => readBotHostState(owner.hostId) === 'live'
                : undefined
            }
          ]
        })
      ),
    [hasHiddenBots, savedEntries]
  )
  return { entries, eligibleEntries, fullSidebarOrder, dragItemById }
}
