import React from 'react'
import { GitMerge, GitPullRequestArrow, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'

export function ConflictSummaryCard({
  conflictOperation,
  unresolvedCount,
  sourceControlAiActionsVisible,
  isResolvingWithAI,
  isAbortingOperation = false,
  onAbortOperation,
  onResolveWithAI,
  onReview
}: {
  conflictOperation: GitConflictOperation
  unresolvedCount: number
  sourceControlAiActionsVisible: boolean
  isResolvingWithAI: boolean
  isAbortingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
  onResolveWithAI: () => void
  onReview: () => void
}): React.JSX.Element {
  const operationLabel =
    conflictOperation === 'merge'
      ? translate(
          'auto.components.right.sidebar.source.control.conflict.status.cards.5302a1ddba',
          'Merge conflicts'
        )
      : conflictOperation === 'rebase'
        ? translate(
            'auto.components.right.sidebar.source.control.conflict.status.cards.7f3af87549',
            'Rebase conflicts'
          )
        : conflictOperation === 'cherry-pick'
          ? translate(
              'auto.components.right.sidebar.source.control.conflict.status.cards.6a8e9ad490',
              'Cherry-pick conflicts'
            )
          : translate(
              'auto.components.right.sidebar.source.control.conflict.status.cards.bdf8772106',
              'Conflicts'
            )

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground" aria-live="polite">
            {translate(
              'auto.components.right.sidebar.SourceControl.d7a5942e41',
              '{{value0}}: {{value1}} unresolved',
              { value0: operationLabel, value1: unresolvedCount }
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.SourceControl.3eeccbb221',
              'Resolved files move back to normal changes after they leave the live conflict state.'
            )}
          </div>
        </div>
      </div>
      <div className="mt-2">
        {sourceControlAiActionsVisible ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 w-full text-xs"
            disabled={isResolvingWithAI}
            onClick={onResolveWithAI}
          >
            {isResolvingWithAI ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {translate('auto.components.right.sidebar.SourceControl.f6cb48b6fe', 'Resolve with AI')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(sourceControlAiActionsVisible && 'mt-1.5', 'h-7 w-full text-xs')}
          onClick={onReview}
        >
          <GitMerge className="size-3.5" />
          {translate('auto.components.right.sidebar.SourceControl.27a50fe970', 'Review conflicts')}
        </Button>
        {(conflictOperation === 'merge' || conflictOperation === 'rebase') && onAbortOperation ? (
          <Button
            type="button"
            // Why: abort is the escape hatch, so use the quiet outline action instead of reading as destructive.
            variant="outline"
            size="sm"
            className="mt-1.5 h-7 w-full text-xs"
            disabled={isResolvingWithAI || isAbortingOperation}
            onClick={() => onAbortOperation(conflictOperation)}
          >
            {isAbortingOperation ? <RefreshCw className="size-3.5 animate-spin" /> : null}
            {conflictOperation === 'rebase'
              ? translate('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
              : translate('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// Why: separate from ConflictSummaryCard because a rebase/merge/cherry-pick can be in progress with no conflicts (between steps, or resolved but pre-continue).
export function OperationBanner({
  conflictOperation,
  isAbortingOperation = false,
  onAbortOperation
}: {
  conflictOperation: GitConflictOperation
  isAbortingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
}): React.JSX.Element {
  const label =
    conflictOperation === 'merge'
      ? translate(
          'auto.components.right.sidebar.source.control.conflict.status.cards.edc2d82a2b',
          'Merge in progress'
        )
      : conflictOperation === 'rebase'
        ? translate(
            'auto.components.right.sidebar.source.control.conflict.status.cards.5c3707aa44',
            'Rebase in progress'
          )
        : conflictOperation === 'cherry-pick'
          ? translate(
              'auto.components.right.sidebar.source.control.conflict.status.cards.ffe53a1da6',
              'Cherry-pick in progress'
            )
          : translate(
              'auto.components.right.sidebar.source.control.conflict.status.cards.35eb76d323',
              'Operation in progress'
            )

  const Icon = conflictOperation === 'rebase' ? GitPullRequestArrow : GitMerge

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center justify-center gap-2">
        <Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-medium text-foreground">{label}</span>
      </div>
      {(conflictOperation === 'merge' || conflictOperation === 'rebase') && onAbortOperation ? (
        <Button
          type="button"
          // Why: abort is the escape hatch, so use the quiet outline action instead of reading as destructive.
          variant="outline"
          size="sm"
          className="mt-2 h-7 w-full text-xs"
          disabled={isAbortingOperation}
          onClick={() => onAbortOperation(conflictOperation)}
        >
          {isAbortingOperation ? <RefreshCw className="size-3.5 animate-spin" /> : null}
          {conflictOperation === 'rebase'
            ? translate('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
            : translate('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')}
        </Button>
      ) : null}
    </div>
  )
}
