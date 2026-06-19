import React from 'react'
import {
  AlertTriangle,
  GitMerge,
  GitPullRequestArrow,
  RefreshCw,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { GitConflictOperation } from '../../../../shared/types'

export function ConflictSummaryCard({
  conflictOperation,
  unresolvedCount,
  isResolvingWithAI,
  isAbortingOperation = false,
  onAbortOperation,
  onResolveWithAI,
  onReview
}: {
  conflictOperation: GitConflictOperation
  unresolvedCount: number
  isResolvingWithAI: boolean
  isAbortingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
  onResolveWithAI: () => void
  onReview: () => void
}): React.JSX.Element {
  const operationLabel =
    conflictOperation === 'merge'
      ? 'Merge conflicts'
      : conflictOperation === 'rebase'
        ? 'Rebase conflicts'
        : conflictOperation === 'cherry-pick'
          ? 'Cherry-pick conflicts'
          : 'Conflicts'

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
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1.5 h-7 w-full text-xs"
          onClick={onReview}
        >
          <GitMerge className="size-3.5" />
          {translate('auto.components.right.sidebar.SourceControl.27a50fe970', 'Review conflicts')}
        </Button>
        {(conflictOperation === 'merge' || conflictOperation === 'rebase') && onAbortOperation ? (
          <Button
            type="button"
            // Why: abort is the escape hatch for this state, so match the quiet
            // outline conflict-review action instead of reading as destructive.
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
      ? 'Merge in progress'
      : conflictOperation === 'rebase'
        ? 'Rebase in progress'
        : conflictOperation === 'cherry-pick'
          ? 'Cherry-pick in progress'
          : 'Operation in progress'

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
          // Why: abort is the escape hatch for this state, so match the quiet
          // outline conflict-review action instead of reading as destructive.
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

export function TooManyChangesBanner({ limit }: { limit: number }): React.JSX.Element {
  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-xs text-foreground">
          {translate(
            'auto.components.right.sidebar.SourceControl.tooManyChanges',
            'Too many changes detected. Only the first {{value0}} are shown.',
            { value0: limit.toLocaleString() }
          )}
        </span>
      </div>
    </div>
  )
}
