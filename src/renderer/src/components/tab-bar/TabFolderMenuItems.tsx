import { FolderPlus, FolderSymlink } from 'lucide-react'
import type { TabFolderGroup } from '../../../../shared/types'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type TabFolderMenuItemsProps = {
  currentFolderGroupId?: string | null
  folderGroups: readonly TabFolderGroup[]
  onCreateGroup: () => void
  onAddToGroup: (folderGroupId: string) => void
  onRemoveFromGroup: () => void
}

export function TabFolderMenuItems({
  currentFolderGroupId,
  folderGroups,
  onCreateGroup,
  onAddToGroup,
  onRemoveFromGroup
}: TabFolderMenuItemsProps): React.JSX.Element {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCreateGroup}>
        <FolderPlus className="mr-1.5 size-3.5" />
        {translate('auto.components.tab.bar.TabFolderMenuItems.groupTab', 'Group Tab')}
      </DropdownMenuItem>
      {folderGroups.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderSymlink className="mr-1.5 size-3.5" />
            {translate('auto.components.tab.bar.TabFolderMenuItems.addToGroup', 'Add to Group')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            {folderGroups.map((group) => (
              <DropdownMenuItem
                key={group.id}
                disabled={group.id === currentFolderGroupId}
                onSelect={() => onAddToGroup(group.id)}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: group.color }} />
                <span className="truncate">{group.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {currentFolderGroupId ? (
        <DropdownMenuItem onSelect={onRemoveFromGroup}>
          {translate(
            'auto.components.tab.bar.TabFolderMenuItems.removeFromGroup',
            'Remove from Group'
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
