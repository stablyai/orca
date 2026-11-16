import {
  CircleX,
  Copy,
  FolderPlus,
  FolderTree,
  Folders,
  GitBranchPlus,
  GitFork,
  Unlink,
  Workflow
} from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import {
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled
} from './worktree-context-menu-policy'

export function WorktreeCopySubMenu({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={model.isDeleting}>
        <Copy className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.copySubmenu', 'Copy')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={model.handleCopyPath} disabled={model.isDeleting}>
          <Copy className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.copyPathOption', 'Path')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={model.handleCopyName} disabled={model.isDeleting}>
          <Copy className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.copyNameOption', 'Worktree Name')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function WorktreeLineageSubMenu({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const { isDeleting, validParentWorktreeId, hasParentLink } = model
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isDeleting}>
        <GitFork className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.lineageSubmenu', 'Parent & Children')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {model.canCreateChildWorktree ? (
          <DropdownMenuItem onSelect={model.handleNewChildWorktree} disabled={isDeleting}>
            <GitBranchPlus className="size-3.5" />
            {t(
              'auto.components.sidebar.WorktreeContextMenu.newChildWorktree',
              'New Child Worktree...'
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={model.handleOpenParentPicker}
          disabled={isWorktreeParentPickerDisabled({
            isDeleting,
            eligibleParentCount: model.eligibleParentCount
          })}
        >
          <FolderTree className="size-3.5" />
          {getWorktreeParentPickerLabel(validParentWorktreeId, t)}
        </DropdownMenuItem>
        {validParentWorktreeId ? (
          <DropdownMenuItem onSelect={model.handleOpenParent} disabled={isDeleting}>
            <Workflow className="size-3.5" />
            {t('auto.components.sidebar.WorktreeContextMenu.8d9cd19d09', 'Open Parent Worktree')}
          </DropdownMenuItem>
        ) : null}
        {hasParentLink ? (
          <DropdownMenuItem onSelect={model.handleRemoveParentLink} disabled={isDeleting}>
            <Unlink className="size-3.5" />
            {t('auto.components.sidebar.WorktreeContextMenu.579b1a8e61', 'Remove from Parent')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

// Kept here as well as the project header: that header menu only renders when grouping by project.
export function WorktreeProjectGroupSubMenu({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const { repo, projectGroups, isDeleting } = model
  if (!repo) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isDeleting}>
        <Folders className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.projectGroupSubmenu', 'Project Group')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={model.handleCreateGroupFromRepo} disabled={isDeleting}>
          <FolderPlus className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.503ec0f8e6', 'New group from project')}
        </DropdownMenuItem>
        {repo.projectGroupId ? (
          <DropdownMenuItem onSelect={model.handleRemoveProjectFromGroup} disabled={isDeleting}>
            <CircleX className="size-3.5" />
            {t('auto.components.sidebar.WorktreeContextMenu.d35dfeae58', 'Remove from group')}
          </DropdownMenuItem>
        ) : null}
        {projectGroups.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t('auto.components.sidebar.WorktreeContextMenu.76865d827f', 'Move to group')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={repo.projectGroupId ?? ''}
              onValueChange={model.handleMoveProjectToGroup}
            >
              {projectGroups.map((group) => (
                <DropdownMenuRadioItem
                  key={group.id}
                  value={group.id}
                  textValue={group.name}
                  disabled={isDeleting || repo.projectGroupId === group.id}
                >
                  <span className="max-w-48 truncate">{group.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
