import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { FolderInput, FolderTree, Unlink, Workflow } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import {
  canShowFolderParentAttachment,
  isFolderParentAttachmentDisabled,
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled
} from './worktree-context-menu-policy'

export function WorktreeParentMenuItems({ model }: { model: WorktreeContextMenuModel }) {
  const {
    worktree,
    repo,
    isMultiContext,
    isDeleting,
    parentMutationPending,
    parentMutationBlocked,
    handleOpenFolderParentPicker,
    handleOpenParentPicker,
    eligibleParentCount,
    validParentWorktreeId,
    hasParentLink,
    parentIsFolderWorkspace,
    handleOpenParent,
    handleRemoveParentLink
  } = model
  return (
    <>
      <DropdownMenuSeparator />
      {canShowFolderParentAttachment({
        worktreeId: worktree.id,
        repoKind: repo?.kind,
        isMultiContext
      }) ? (
        <DropdownMenuItem
          onSelect={handleOpenFolderParentPicker}
          disabled={isFolderParentAttachmentDisabled({
            isDeleting,
            pending: parentMutationPending
          })}
        >
          <FolderInput className="size-3.5" />
          {translate(
            'auto.components.sidebar.WorktreeContextMenu.attachFolderWorkspace',
            'Attach to Folder Workspace…'
          )}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        onSelect={handleOpenParentPicker}
        disabled={isWorktreeParentPickerDisabled({
          isDeleting: isDeleting || parentMutationBlocked,
          eligibleParentCount
        })}
      >
        <FolderTree className="size-3.5" />
        {getWorktreeParentPickerLabel(validParentWorktreeId, parentIsFolderWorkspace)}
      </DropdownMenuItem>
      {(validParentWorktreeId || hasParentLink) && (
        <>
          {validParentWorktreeId && (
            <DropdownMenuItem onSelect={handleOpenParent} disabled={isDeleting}>
              <Workflow className="size-3.5" />
              {translate(
                'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
                'Open Parent Worktree'
              )}
            </DropdownMenuItem>
          )}
          {hasParentLink && (
            <DropdownMenuItem
              onSelect={handleRemoveParentLink}
              disabled={isDeleting || parentMutationBlocked}
            >
              <Unlink className="size-3.5" />
              {parentIsFolderWorkspace && !validParentWorktreeId
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.removeFromFolderWorkspace',
                    'Remove from Folder Workspace'
                  )
                : translate(
                    'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                    'Remove from Parent'
                  )}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
        </>
      )}
    </>
  )
}
