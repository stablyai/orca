import { FolderInput } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { assignPinnedGroup } from '@/store/pinned-groups/pinned-group-actions'
import { useTranslate } from '@/i18n/use-translate'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

export function PinnedWorktreeGroupMenuItems({
  model
}: {
  model: Pick<
    WorktreeContextMenuModel,
    | 'folderWorkspaceId'
    | 'pinnedGroupWorktree'
    | 'pinnedGroupByWorktreeIdentity'
    | 'pinnedGroups'
    | 'isDeleting'
    | 'handleCreatePinnedGroup'
  >
}) {
  const t = useTranslate()
  const worktree = model.folderWorkspaceId ? null : model.pinnedGroupWorktree
  if (!worktree) {
    return null
  }
  const groupId = model.pinnedGroupByWorktreeIdentity?.[getWorktreeHostIdentity(worktree)]
  const groups = [...(model.pinnedGroups ?? [])].sort((a, b) => a.order - b.order)
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={model.isDeleting}>
          <FolderInput className="size-3.5" />
          {t('auto.components.sidebar.PinnedGroups.addToGroup', 'Add to group')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {groups.map((group) => (
            <DropdownMenuItem
              key={group.id}
              disabled={group.id === groupId}
              onSelect={() => {
                void assignPinnedGroup(worktree, group.id).catch(console.error)
              }}
            >
              {group.name}
            </DropdownMenuItem>
          ))}
          {groups.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={model.handleCreatePinnedGroup}>
            {t('auto.components.sidebar.PinnedGroups.newGroupAction', 'New group…')}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {groups.some((group) => group.id === groupId) ? (
        <DropdownMenuItem
          disabled={model.isDeleting}
          onSelect={() => {
            void assignPinnedGroup(worktree, null).catch(console.error)
          }}
        >
          {t('auto.components.sidebar.PinnedGroups.removeFromGroup', 'Remove from group')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
