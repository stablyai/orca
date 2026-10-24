import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { GitMerge, Undo2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

/**
 * Merge-review rows for one workspace card. A pending review replaces the sync
 * action with accept/reject, so the menu never offers two ways to start one.
 */
export function WorktreeMergeReviewMenuItems({
  model
}: {
  model: WorktreeContextMenuModel
}): React.JSX.Element | null {
  const { mergeReviewMode, isDeleting } = model
  if (mergeReviewMode === 'none') {
    return null
  }
  if (mergeReviewMode === 'pending') {
    return (
      <>
        <DropdownMenuItem onSelect={model.handleMergeReviewAccept} disabled={isDeleting}>
          <GitMerge className="size-3.5" />
          {translate('components.sidebar.mergeReview.accept', 'Accept Merge')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={model.handleMergeReviewReject}
          disabled={isDeleting}
        >
          <Undo2 className="size-3.5" />
          {translate('components.sidebar.mergeReview.reject', 'Undo Merge')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>
    )
  }
  return (
    <>
      <DropdownMenuItem onSelect={model.handleMergeReviewSync} disabled={isDeleting}>
        <GitMerge className="size-3.5" />
        {translate('components.sidebar.mergeReview.sync', 'Merge into Main Worktree')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )
}
