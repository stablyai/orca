import React from 'react'
import { GitMerge, GitPullRequestArrow, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'

export function ConflictSummaryCard({
  children,
  conflictOperation,
  unresolvedCount,
  sourceControlAiActionsVisible,
  isRecoveryBusy = false,
  isAbortingOperation = false,
  onAbortOperation,
  onResolveWithAI,
  onReview
}: {
  children?: React.ReactNode
  conflictOperation: GitConflictOperation
  unresolvedCount: number
  sourceControlAiActionsVisible: boolean
  isRecoveryBusy?: boolean
  isAbortingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
  onResolveWithAI: () => void
  onReview: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const operationLabel =
    conflictOperation === 'merge'
      ? t(
          'auto.components.right.sidebar.source.control.conflict.status.cards.5302a1ddba',
          'Merge conflicts'
        )
      : conflictOperation === 'rebase'
        ? t(
            'auto.components.right.sidebar.source.control.conflict.status.cards.7f3af87549',
            'Rebase conflicts'
          )
        : conflictOperation === 'cherry-pick'
          ? t(
              'auto.components.right.sidebar.source.control.conflict.status.cards.6a8e9ad490',
              'Cherry-pick conflicts'
            )
          : conflictOperation === 'revert'
            ? t('gitGraph.revertConflicts', 'Revert conflicts')
            : t(
                'auto.components.right.sidebar.source.control.conflict.status.cards.bdf8772106',
                'Conflicts'
              )

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground" aria-live="polite">
            {t(
              'auto.components.right.sidebar.SourceControl.d7a5942e41',
              '{{value0}}: {{value1}} unresolved',
              { value0: operationLabel, value1: unresolvedCount }
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t(
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
            disabled={isAbortingOperation || isRecoveryBusy}
            onClick={onResolveWithAI}
          >
            <Sparkles className="size-3.5" />
            {t('auto.components.right.sidebar.SourceControl.f6cb48b6fe', 'Resolve with AI')}
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
          {t('auto.components.right.sidebar.SourceControl.27a50fe970', 'Review conflicts')}
        </Button>
        {(conflictOperation === 'merge' || conflictOperation === 'rebase') && onAbortOperation ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1.5 h-7 w-full text-xs"
            disabled={isAbortingOperation}
            onClick={() => onAbortOperation(conflictOperation)}
          >
            {isAbortingOperation ? <RefreshCw className="size-3.5 animate-spin" /> : null}
            {conflictOperation === 'rebase'
              ? t('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
              : t('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')}
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  )
}

// Paused rebase/merge/cherry-pick operations may need recovery even with no conflicted files.
export function OperationBanner({
  children,
  conflictOperation,
  isRecoveryBusy = false,
  isAbortingOperation = false,
  onAbortOperation,
  isCompletingMerge = false,
  onCompleteMerge,
  sourceControlAiActionsVisible = false,
  onResolveWithAI
}: {
  children?: React.ReactNode
  conflictOperation: GitConflictOperation
  isRecoveryBusy?: boolean
  isAbortingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
  isCompletingMerge?: boolean
  onCompleteMerge?: () => void
  sourceControlAiActionsVisible?: boolean
  onResolveWithAI?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label =
    conflictOperation === 'merge'
      ? t(
          'auto.components.right.sidebar.source.control.conflict.status.cards.edc2d82a2b',
          'Merge in progress'
        )
      : conflictOperation === 'rebase'
        ? t(
            'auto.components.right.sidebar.source.control.conflict.status.cards.5c3707aa44',
            'Rebase in progress'
          )
        : conflictOperation === 'cherry-pick'
          ? t(
              'auto.components.right.sidebar.source.control.conflict.status.cards.ffe53a1da6',
              'Cherry-pick in progress'
            )
          : conflictOperation === 'revert'
            ? t('gitGraph.revertInProgress', 'Revert in progress')
            : t(
                'auto.components.right.sidebar.source.control.conflict.status.cards.35eb76d323',
                'Operation in progress'
              )

  const Icon = conflictOperation === 'rebase' ? GitPullRequestArrow : GitMerge
  const canCompleteMerge = conflictOperation === 'merge' && !!onCompleteMerge

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center justify-center gap-2">
        <Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-medium text-foreground">{label}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {canCompleteMerge ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 w-full text-xs"
            disabled={isCompletingMerge || isAbortingOperation || isRecoveryBusy}
            onClick={onCompleteMerge}
          >
            {isCompletingMerge ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <GitMerge className="size-3.5" />
            )}
            {t(
              'auto.components.right.sidebar.source.control.conflict.status.cards.completeMerge',
              'Complete merge'
            )}
          </Button>
        ) : null}
        {sourceControlAiActionsVisible && onResolveWithAI ? (
          <Button
            type="button"
            variant={canCompleteMerge ? 'outline' : 'default'}
            size="sm"
            className="h-7 w-full text-xs"
            disabled={isAbortingOperation || isRecoveryBusy || isCompletingMerge}
            onClick={onResolveWithAI}
          >
            <Sparkles className="size-3.5" />
            {t('auto.components.right.sidebar.SourceControl.f6cb48b6fe', 'Resolve with AI')}
          </Button>
        ) : null}
        {(conflictOperation === 'merge' || conflictOperation === 'rebase') && onAbortOperation ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            disabled={isAbortingOperation || isCompletingMerge}
            onClick={() => onAbortOperation(conflictOperation)}
          >
            {isAbortingOperation ? <RefreshCw className="size-3.5 animate-spin" /> : null}
            {conflictOperation === 'rebase'
              ? t('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
              : t('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')}
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  )
}
