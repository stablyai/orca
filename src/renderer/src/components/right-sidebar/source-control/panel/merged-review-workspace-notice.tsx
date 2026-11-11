import React from 'react'
import { GitMerge, LoaderCircle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { resolveMergedReviewWorkspaceReadiness } from '../../../../../../shared/source-control/decisions/merged-review-workspace-readiness'
import { runWorktreeDelete } from '../../../sidebar/workspace-actions/deletion/delete-worktree-flow'
import { getDeleteStateForWorktreeHost } from '../../../sidebar/workspace-actions/deletion/worktree-delete-state-host-match'

/** Says whether a merged workspace still holds work; the branch compare alone keeps squash-merged commits listed. */
export function SourceControlMergedReviewNotice({
  review,
  worktree,
  statusHeadOid,
  uncommittedCount
}: {
  review: HostedReviewInfo | null
  worktree: Worktree
  /** HEAD from the latest successful git status read; null until one completes. */
  statusHeadOid: string | null
  uncommittedCount: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const isDeleting = useAppStore(
    (s) => getDeleteStateForWorktreeHost(worktree, s.deleteStateByWorktreeId)?.isDeleting ?? false
  )
  const readiness = resolveMergedReviewWorkspaceReadiness({
    review,
    headOid: statusHeadOid,
    uncommittedCount
  })
  // Without a status read the change count is unknown, so say nothing rather than guess.
  if (!review || !readiness || !statusHeadOid) {
    return null
  }
  const label = `${
    localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(review.provider), t)
      .shortLabel
  } #${review.number}`
  const canDelete = readiness.kind === 'safe-to-delete' && !worktree.isMainWorktree

  let message: string
  if (readiness.kind === 'uncommitted-changes') {
    message = t(
      'auto.components.right.sidebar.SourceControl.mergedReviewUncommitted',
      '{{review}} is merged, but this workspace has {{count}} uncommitted changes that are not in it.',
      {
        review: label,
        count: readiness.count,
        defaultValue_one:
          '{{review}} is merged, but this workspace has {{count}} uncommitted change that is not in it.'
      }
    )
  } else if (readiness.kind === 'head-not-in-review') {
    message = t(
      'auto.components.right.sidebar.SourceControl.mergedReviewHeadMoved',
      '{{review}} is merged, but this branch has commits that are not in it.',
      { review: label }
    )
  } else if (worktree.isMainWorktree) {
    message = t(
      'auto.components.right.sidebar.SourceControl.mergedReviewNothingLeft',
      '{{review}} is merged and everything on this branch is in it.',
      { review: label }
    )
  } else {
    message = t(
      'auto.components.right.sidebar.SourceControl.mergedReviewSafeToDelete',
      '{{review}} is merged and everything in this workspace is in it. It is safe to delete.',
      { review: label }
    )
  }

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-muted-foreground"
      role="status"
    >
      <GitMerge className="mt-0.5 size-3.5 shrink-0 text-callout-important" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <span>{message}</span>
        {canDelete ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="cursor-pointer"
            disabled={isDeleting}
            onClick={() =>
              runWorktreeDelete(
                worktree.id,
                worktree.hostId ? { expectedHostId: worktree.hostId } : {}
              )
            }
          >
            {isDeleting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {isDeleting
              ? t('auto.components.right.sidebar.HostedReviewActions.eefd50457e', 'Deleting...')
              : t(
                  'auto.components.right.sidebar.HostedReviewActions.e4aca40024',
                  'Delete Workspace'
                )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
