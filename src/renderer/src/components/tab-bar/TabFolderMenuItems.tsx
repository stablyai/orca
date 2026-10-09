import { FolderMinus, FolderPlus, FolderSymlink, Pencil } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { TAB_CONTEXT_SUBMENU_CONTENT_CLASS } from './tab-context-menu-sizing'

const EMPTY_FOLDER_GROUPS: never[] = []

type TabFolderMenuItemsProps = {
  unifiedTabId: string
  worktreeId: string
  splitGroupId: string
}

export function TabFolderMenuItems({
  unifiedTabId,
  worktreeId,
  splitGroupId
}: TabFolderMenuItemsProps): React.JSX.Element {
  const currentFolderGroupId = useAppStore((state) => {
    const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => candidate.id === unifiedTabId
    )
    return tab?.folderGroupId ?? null
  })
  const foldersForWorktree = useAppStore(
    (state) => state.tabFolderGroupsByWorktree?.[worktreeId] ?? EMPTY_FOLDER_GROUPS
  )
  const folderGroups = foldersForWorktree.filter((folder) => folder.splitGroupId === splitGroupId)
  const createTabFolderGroup = useAppStore((state) => state.createTabFolderGroup)
  const addTabsToFolderGroup = useAppStore((state) => state.addTabsToFolderGroup)
  const moveTabOutOfFolderGroup = useAppStore((state) => state.moveTabOutOfFolderGroup)
  const setRenamingFolderGroupId = useAppStore((state) => state.setRenamingFolderGroupId)

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => createTabFolderGroup?.([unifiedTabId])}>
        <FolderPlus className="size-3.5" />
        {translate('components.tab.bar.TabFolderMenuItems.newFolder', 'New folder')}
      </DropdownMenuItem>
      {folderGroups.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderSymlink className="size-3.5" />
            {translate('components.tab.bar.TabFolderMenuItems.addToFolder', 'Add to folder')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={TAB_CONTEXT_SUBMENU_CONTENT_CLASS}>
            {folderGroups.map((group) => (
              <DropdownMenuItem
                key={group.id}
                disabled={group.id === currentFolderGroupId}
                onSelect={() => addTabsToFolderGroup?.(group.id, [unifiedTabId])}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: group.color }} />
                <span className="truncate">{group.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {currentFolderGroupId ? (
        <>
          <DropdownMenuItem onSelect={() => moveTabOutOfFolderGroup?.(unifiedTabId)}>
            <FolderMinus className="size-3.5" />
            {translate(
              'components.tab.bar.TabFolderMenuItems.removeFromFolder',
              'Remove from folder'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenamingFolderGroupId?.(currentFolderGroupId)}>
            <Pencil className="size-3.5" />
            {translate('components.tab.bar.TabFolderMenuItems.renameFolder', 'Rename folder')}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}
