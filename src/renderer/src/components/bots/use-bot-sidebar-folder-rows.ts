import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  getProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragItem
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import { getBotSidebarFolderGroupKey } from '../../../../shared/bots/bot-sidebar-folders'
import { getBotSidebarGroupFoldKey } from '../../../../shared/bots/bot-sidebar-group-parents'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { groupMemberKeys } from './bot-group-members-dialog-roster'
import {
  botSidebarFolderRowId,
  buildBotSidebarFolderRows,
  getBotSidebarMemberships
} from './bot-sidebar-folder-rows'

type SortableEntry = { id: string } & (
  | { kind: 'bot'; bot: { sidebarOrder?: number } }
  | { kind: 'group'; group: { sidebarOrder?: number } }
)

export function useBotSidebarFolderRows<Entry extends SortableEntry>(
  entries: readonly Entry[],
  groups: readonly BotGroup[]
) {
  const { folders, placements, groupParents } = useAppStore((s) => s.botSidebarFolders)
  const groupIds = useMemo(() => groups.map(botSidebarEntryKey), [groups])
  const folderFoldKeys = useMemo(
    () => folders.map(({ id }) => getBotSidebarFolderGroupKey(id)),
    [folders]
  )
  const groupFoldKeys = useMemo(() => groupIds.map(getBotSidebarGroupFoldKey), [groupIds])
  const foldKeys = useMemo(
    () => [...folderFoldKeys, ...groupFoldKeys],
    [folderFoldKeys, groupFoldKeys]
  )
  const foldedKeys = useAppStore(
    useShallow((s) => foldKeys.filter((key) => s.collapsedGroups.has(key)))
  )
  const memberKeysByGroup = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          botSidebarEntryKey(group),
          groupMemberKeys(group, botSidebarEntryKey)
        ])
      ),
    [groups]
  )
  const groupsByMember = useMemo(
    () => getBotSidebarMemberships(memberKeysByGroup),
    [memberKeysByGroup]
  )
  const treeRows = useMemo(() => {
    const folded = new Set(foldedKeys)
    return buildBotSidebarFolderRows({
      entries,
      folders,
      folderPlacements: placements,
      groupParents,
      groupsByMember,
      isExpanded: (folderId) => !folded.has(getBotSidebarFolderGroupKey(folderId)),
      isGroupExpanded: (groupId) => !folded.has(getBotSidebarGroupFoldKey(groupId))
    })
  }, [entries, folders, placements, groupParents, groupsByMember, foldedKeys])

  const { botIdsByBucket, dragItemById } = useMemo(() => {
    const buckets = new Map<string, string[]>()
    const items = new Map<string, ProjectGroupHeaderDragItem>()
    for (const { id } of folders) {
      items.set(botSidebarFolderRowId(id), { parentGroupId: null, tabOrder: 0 })
    }
    for (const row of treeRows) {
      if (row.kind !== 'entry') {
        continue
      }
      const { entry, parentId } = row
      const owner = entry.kind === 'bot' ? entry.bot : entry.group
      const item = { parentGroupId: parentId, tabOrder: owner.sidebarOrder ?? -1 }
      items.set(entry.id, item)
      const bucket = getProjectGroupHeaderDragBucketKey(item)
      const siblings = buckets.get(bucket) ?? []
      siblings.push(entry.id)
      buckets.set(bucket, siblings)
    }
    return { botIdsByBucket: buckets, dragItemById: items }
  }, [folders, treeRows])
  return {
    treeRows,
    botIdsByBucket,
    dragItemById,
    memberKeysByGroup,
    hasFolders: folders.length > 0
  }
}
