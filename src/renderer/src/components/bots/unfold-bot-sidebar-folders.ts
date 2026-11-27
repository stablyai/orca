import { useAppStore } from '@/store'
import { recordCollapsedGroupChanges } from '@/store/slices/ui/collapsed-group-toggle'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { readBotHostIds } from '@/lib/bot-catalog-snapshot'
import { withKeptBotHomes } from '@/lib/bot-host-kept-homes'
import { getBotHomes } from '../../../../shared/bots/bot-homes'
import {
  getBotSidebarFolderGroupKey,
  getBotSidebarFolderPathIds,
  indexBotSidebarFolders
} from '../../../../shared/bots/bot-sidebar-folders'
import {
  getBotSidebarGroupFoldKey,
  getBotSidebarGroupPath,
  moveBotSidebarGroup
} from '../../../../shared/bots/bot-sidebar-group-parents'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { groupMemberKeys } from './bot-group-members-dialog-roster'

function unfoldKeys(keys: readonly string[]): void {
  const { collapsedGroups, setCollapsedGroups } = useAppStore.getState()
  const folded = keys.filter((key) => collapsedGroups.has(key))
  if (folded.length > 0) {
    const next = new Set(collapsedGroups)
    for (const key of folded) {
      next.delete(key)
    }
    setCollapsedGroups(recordCollapsedGroupChanges(collapsedGroups, next, folded))
  }
}

export function unfoldBotSidebarFolder(folderId: string): void {
  const { folders } = useAppStore.getState().botSidebarFolders
  unfoldKeys(getBotSidebarFolderPathIds(folders, folderId).map(getBotSidebarFolderGroupKey))
}

export function moveBotGroupInSidebar(entryKey: string, parentKey: string | null): void {
  const { botSidebarFolders, setBotSidebarFolders } = useAppStore.getState()
  const groupParents = moveBotSidebarGroup(botSidebarFolders.groupParents, entryKey, parentKey)
  if (groupParents !== botSidebarFolders.groupParents) {
    setBotSidebarFolders({ ...botSidebarFolders, groupParents })
    if (parentKey !== null) {
      unfoldKeys(getBotSidebarGroupPath(groupParents, parentKey).map(getBotSidebarGroupFoldKey))
    }
  }
}

export function unfoldBotSidebarEntry(
  entryKey: string,
  additionalKeys: Iterable<string> = [BOTS_GROUP_KEY]
): void {
  const state = useAppStore.getState()
  const { folders, placements, groupParents } = state.botSidebarFolders
  if (indexBotSidebarFolders(folders).has(placements[entryKey])) {
    const folderKeys = getBotSidebarFolderPathIds(folders, placements[entryKey]).map(
      getBotSidebarFolderGroupKey
    )
    unfoldKeys([...additionalKeys, ...folderKeys])
    return
  }

  const homes = withKeptBotHomes(selectFolderWorkspaces(state) ?? [], readBotHostIds())
  const groupRows = getBotHomes(readBotGroups(), homes).map(({ bot }) => bot)
  const isGroup = groupRows.some((group) => botSidebarEntryKey(group) === entryKey)
  const containingGroup = isGroup
    ? groupParents[entryKey]
    : groupRows
        .filter((group) => groupMemberKeys(group, botSidebarEntryKey).includes(entryKey))
        .map(botSidebarEntryKey)
        .sort()[0]
  const groupKeys = containingGroup
    ? getBotSidebarGroupPath(groupParents, containingGroup).map(getBotSidebarGroupFoldKey)
    : []
  unfoldKeys([...additionalKeys, ...groupKeys])
}
