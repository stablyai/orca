import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { FolderInput, FolderTree, Workflow, Unlink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useWorktreeLineageTreeStore } from '@/store/worktree-lineage-tree-store'
import {
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled
} from './worktree-context-menu-policy'
import type { Worktree } from '../../../../shared/worktree/types'

export function WorktreeLineageMenuItems(props: {
  worktree: Worktree
  isDeleting: boolean
  eligibleParentCount: number
  validParentWorktreeId: string | null
  hasParentLink: boolean
  lineageDescendantCount: number
  onOpenParentPicker: () => void
  onOpenParent: () => void
  onRemoveParentLink: () => void
}): React.JSX.Element {
  const hasLineageRelations = Boolean(
    props.validParentWorktreeId || props.lineageDescendantCount > 0
  )

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={props.onOpenParentPicker}
        disabled={isWorktreeParentPickerDisabled({
          isDeleting: props.isDeleting,
          eligibleParentCount: props.eligibleParentCount
        })}
      >
        <FolderInput className="size-3.5" />
        {getWorktreeParentPickerLabel(props.validParentWorktreeId)}
      </DropdownMenuItem>
      {hasLineageRelations && (
        <DropdownMenuItem
          onSelect={() =>
            useWorktreeLineageTreeStore.getState().openLineageTree({
              worktreeId: props.worktree.id
            })
          }
          disabled={props.isDeleting}
        >
          <FolderTree className="size-3.5" />
          {translate(
            'auto.components.sidebar.WorktreeContextMenu.viewLineageTree',
            'View Lineage Tree...'
          )}
        </DropdownMenuItem>
      )}
      {(props.validParentWorktreeId || props.hasParentLink) && (
        <>
          {props.validParentWorktreeId && (
            <DropdownMenuItem onSelect={props.onOpenParent} disabled={props.isDeleting}>
              <Workflow className="size-3.5" />
              {translate(
                'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
                'Open Parent Worktree'
              )}
            </DropdownMenuItem>
          )}
          {props.hasParentLink && (
            <DropdownMenuItem onSelect={props.onRemoveParentLink} disabled={props.isDeleting}>
              <Unlink className="size-3.5" />
              {translate(
                'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                'Remove from Parent'
              )}
            </DropdownMenuItem>
          )}
        </>
      )}
      <DropdownMenuSeparator />
    </>
  )
}
