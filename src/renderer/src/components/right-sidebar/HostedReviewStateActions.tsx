import {
  ChevronDown,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  LoaderCircle,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS,
  RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS
} from './right-sidebar-primary-action-layout'

export function HostedReviewActionError({
  message
}: {
  message: string | null
}): React.JSX.Element | null {
  return message ? <div className="text-[10px] text-rose-500 break-words">{message}</div> : null
}

export function DraftReviewActions({
  shortLabel,
  reviewLabel,
  isGitLab,
  readying,
  stateUpdating,
  actionError,
  onMarkReadyForReview,
  onCloseReview
}: {
  shortLabel: string
  reviewLabel: string
  isGitLab: boolean
  readying: boolean
  stateUpdating: 'open' | 'closed' | null
  actionError: string | null
  onMarkReadyForReview: () => void
  onCloseReview: () => void
}): React.JSX.Element {
  const disabled = readying || stateUpdating !== null
  const ReadyIcon = isGitLab ? GitMerge : GitPullRequestArrow
  return (
    <div className="space-y-1.5">
      <div className={RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS}>
        <Button
          type="button"
          size="xs"
          className="min-w-0 rounded-r-none px-3 text-[11px] disabled:cursor-not-allowed"
          onClick={onMarkReadyForReview}
          disabled={disabled}
        >
          {readying ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <ReadyIcon className="size-3.5" />
          )}
          <span className={RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS}>
            {readying
              ? translate(
                  'auto.components.right.sidebar.HostedReviewActions.markingReady',
                  'Marking ready...'
                )
              : translate(
                  'auto.components.right.sidebar.HostedReviewActions.markReady',
                  'Mark ready for review'
                )}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="xs"
              className="shrink-0 rounded-l-none border-l border-primary-foreground/20 px-1.5 disabled:cursor-not-allowed"
              disabled={disabled}
              aria-label={translate(
                'auto.components.right.sidebar.HostedReviewActions.draftMoreActions',
                'More {{value0}} actions',
                { value0: reviewLabel }
              )}
            >
              {stateUpdating === 'closed' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem variant="destructive" onSelect={onCloseReview}>
              <GitPullRequestClosed className="size-3.5" />
              {translate(
                'auto.components.right.sidebar.HostedReviewActions.closeDraft',
                'Close'
              )}{' '}
              {shortLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <HostedReviewActionError message={actionError} />
    </div>
  )
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
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="cursor-pointer text-[11px] hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
      variant="outline"
      size="xs"
      // Why: outline matches the sibling Reopen control; destructive text signals danger
      // without a solid red fill dominating the PR summary panel.
      className="cursor-pointer border-destructive/30 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
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
