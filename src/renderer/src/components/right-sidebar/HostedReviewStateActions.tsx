import { CircleDot, LoaderCircle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function HostedReviewActionError({
  message
}: {
  message: string | null
}): React.JSX.Element | null {
  return message ? <div className="text-[10px] text-rose-500 break-words">{message}</div> : null
}

export function ClosedReviewActions({
  shortLabel,
  stateUpdating,
  actionError,
  onReopenReview
}: {
  shortLabel: string
  stateUpdating: 'open' | 'closed' | null
  actionError: string | null
  onReopenReview: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="w-full cursor-pointer text-[11px] hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onReopenReview}
        disabled={stateUpdating !== null}
      >
        {stateUpdating === 'open' ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <CircleDot className="size-3.5" />
        )}
        {stateUpdating === 'open'
          ? translate(
              'auto.components.right.sidebar.HostedReviewActions.6645ac7dd1',
              'Reopening...'
            )
          : translate(
              'auto.components.right.sidebar.HostedReviewActions.3ce211ece6',
              'Reopen {{value0}}',
              { value0: shortLabel }
            )}
      </Button>
      <HostedReviewActionError message={actionError} />
    </div>
  )
}

export function MergedReviewActions({
  isDeletingWorktree,
  onDeleteWorktree
}: {
  isDeletingWorktree: boolean
  onDeleteWorktree: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      className="w-full cursor-pointer text-[11px] hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      onClick={onDeleteWorktree}
      disabled={isDeletingWorktree}
    >
      {isDeletingWorktree ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Trash2 className="size-3.5" />
      )}
      {isDeletingWorktree
        ? translate('auto.components.right.sidebar.HostedReviewActions.eefd50457e', 'Deleting...')
        : translate(
            'auto.components.right.sidebar.HostedReviewActions.e4aca40024',
            'Delete Workspace'
          )}
    </Button>
  )
}
