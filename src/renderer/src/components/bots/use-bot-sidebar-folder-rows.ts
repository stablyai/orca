import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  getProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragItem
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import { getBotSidebarFolderGroupKey } from '../../../../shared/bots/bot-sidebar-folders'
import { buildBotSidebarFolderRows } from './bot-sidebar-folder-rows'

type SortableEntry = { id: string } & (
  | { kind: 'bot'; bot: { sidebarOrder?: number } }
  | { kind: 'group'; group: { sidebarOrder?: number } }
)

export function useBotSidebarFolderRows<Entry extends SortableEntry>(entries: readonly Entry[]) {
  const { folders, placements } = useAppStore((s) => s.botSidebarFolders)
  const foldedFolderIds = useAppStore(
    useShallow((s) =>
      folders.filter(({ id }) => s.collapsedGroups.has(getBotSidebarFolderGroupKey(id)))
    )
  )
  const treeRows = useMemo(() => {
    const folded = new Set(foldedFolderIds.map(({ id }) => id))
    return buildBotSidebarFolderRows({
      entries,
      folders,
      folderPlacements: placements,
      isExpanded: (folderId) => !folded.has(folderId)
    })
  }, [entries, folders, placements, foldedFolderIds])

  const { botIdsByBucket, dragItemById } = useMemo(() => {
    const buckets = new Map<string, string[]>()
    const items = new Map<string, ProjectGroupHeaderDragItem>()
    for (const { id } of folders) {
      items.set(id, { parentGroupId: null, tabOrder: 0 })
    }
    for (const row of treeRows) {
      if (row.kind !== 'entry') {
        continue
      }
      const { entry, folderId } = row
      const owner = entry.kind === 'bot' ? entry.bot : entry.group
      const item = { parentGroupId: folderId, tabOrder: owner.sidebarOrder ?? -1 }
      items.set(entry.id, item)
      const bucket = getProjectGroupHeaderDragBucketKey(item)
      const siblings = buckets.get(bucket) ?? []
      siblings.push(entry.id)
      buckets.set(bucket, siblings)
    }
    return { botIdsByBucket: buckets, dragItemById: items }
  }, [folders, treeRows])
  return { treeRows, botIdsByBucket, dragItemById, hasFolders: folders.length > 0 }
}
