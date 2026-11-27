import { useAppStore } from '@/store'
import { recordCollapsedGroupChanges } from '@/store/slices/ui/collapsed-group-toggle'
import {
  getBotSidebarFolderGroupKey,
  getBotSidebarFolderPathIds
} from '../../../../shared/bots/bot-sidebar-folders'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'

function unfoldBotSidebarPath(
  folderId: string | undefined,
  additionalKeys: Iterable<string>
): void {
  const { botSidebarFolders, collapsedGroups, setCollapsedGroups } = useAppStore.getState()
  const foldKeys = getBotSidebarFolderPathIds(botSidebarFolders.folders, folderId).map(
    getBotSidebarFolderGroupKey
  )
  foldKeys.push(...additionalKeys)
  const folded = foldKeys.filter((key) => collapsedGroups.has(key))
  if (folded.length > 0) {
    const next = new Set(collapsedGroups)
    for (const key of folded) {
      next.delete(key)
    }
    setCollapsedGroups(recordCollapsedGroupChanges(collapsedGroups, next, folded))
  }
}

export function unfoldBotSidebarFolder(folderId: string): void {
  unfoldBotSidebarPath(folderId, [])
}

export function unfoldBotSidebarEntry(
  entryKey: string,
  additionalKeys: Iterable<string> = [BOTS_GROUP_KEY]
): void {
  const { placements } = useAppStore.getState().botSidebarFolders
  unfoldBotSidebarPath(placements[entryKey], additionalKeys)
}
