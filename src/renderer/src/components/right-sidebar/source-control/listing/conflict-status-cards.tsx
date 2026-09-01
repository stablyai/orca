import React from 'react'
import { GitMerge, GitPullRequestArrow, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { shortGitHead } from '@/lib/worktree-git-identity-display'
import type {
  GitConflictOperation,
  GitOperationProgress
} from '../../../../../../shared/git-status-types'
import { SourceControlOperationBannerActions } from './operation-banner-actions'

/**
 * Shared shell for both conflict states. Why: `git rebase --continue` can land
 * straight in a new conflict, swapping ConflictSummaryCard for OperationBanner
 * mid-flight — a shared shell keeps the box identical so only its contents change.
 */
export function OperationCardShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2"
      data-testid="source-control-operation-card"
    >
      {children}
    </div>
  )
}

function conflictsHeading(conflictOperation: GitConflictOperation): string {
  if (conflictOperation === 'merge') {
    return translate(
      'auto.components.right.sidebar.source.control.conflict.status.cards.5302a1ddba',
      'Merge conflicts'
    )
  }
  if (conflictOperation === 'rebase') {
    return translate(
      'auto.components.right.sidebar.source.control.conflict.status.cards.7f3af87549',
      'Rebase conflicts'
    )
  }
  if (conflictOperation === 'cherry-pick') {
    return translate(
      'auto.components.right.sidebar.source.control.conflict.status.cards.6a8e9ad490',
      'Cherry-pick conflicts'
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.conflict.status.cards.bdf8772106',
    'Conflicts'
  )
}

// Full 40-char oids only get truncated by CSS, which reads as a broken value.
// shortGitHead keeps this abbreviation in step with the head identity chip's.
function shortenOnto(onto: string | undefined): string | undefined {
  return onto && /^[0-9a-f]{40}$/i.test(onto) ? shortGitHead(onto) : onto
}

function inProgressHeading(conflictOperation: GitConflictOperation): string {
  if (conflictOperation === 'merge') {
    return translate(
      'auto.components.right.sidebar.source.control.conflict.status.cards.edc2d82a2b',
      'Merge in progress'
    )
  }
  if (conflictOperation === 'rebase') {
    return translate(
      'auto.components.right.sidebar.source.control.conflict.status.cards.5c3707aa44',
      'Rebase in progress'
    )
  }
  if (conflictOperation === 'cherry-pick') {
    return translate(
      'auto.components.right.sidebar.source.control.conflict.status.cards.ffe53a1da6',
      'Cherry-pick in progress'
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.conflict.status.cards.35eb76d323',
    'Operation in progress'
  )
}

type SharedOperationCardProps = {
  conflictOperation: GitConflictOperation
  sourceControlAiActionsVisible: boolean
  isResolvingWithAI: boolean
  isAbortingOperation?: boolean
  isAdvancingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
  onContinueOperation?: (operation: GitConflictOperation) => void
}

export function ConflictSummaryBody({
  conflictOperation,
  unresolvedCount,
  sourceControlAiActionsVisible,
  isResolvingWithAI,
  isAbortingOperation = false,
  isAdvancingOperation = false,
  onAbortOperation,
  onContinueOperation,
  onResolveWithAI,
  onReview
}: SharedOperationCardProps & {
  unresolvedCount: number
  onResolveWithAI: () => void
  onReview: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 text-xs font-medium text-foreground" aria-live="polite">
          {translate(
            'auto.components.right.sidebar.SourceControl.d7a5942e41',
            '{{value0}}: {{value1}} unresolved',
            { value0: conflictsHeading(conflictOperation), value1: unresolvedCount }
          )}
        </div>
      </div>
      <SourceControlOperationBannerActions
        conflictOperation={conflictOperation}
        hasUnresolvedConflicts
        sourceControlAiActionsVisible={sourceControlAiActionsVisible}
        isResolvingWithAI={isResolvingWithAI}
        isAbortingOperation={isAbortingOperation}
        isAdvancingOperation={isAdvancingOperation}
        onAbortOperation={onAbortOperation}
        onContinueOperation={onContinueOperation}
        onResolveWithAI={onResolveWithAI}
        onReviewConflicts={onReview}
      />
    </>
  )
}

/** Standalone card. The panel composes OperationCardShell + a body directly so the box survives a mid-flight swap. */
export function ConflictSummaryCard(
  props: React.ComponentProps<typeof ConflictSummaryBody>
): React.JSX.Element {
  return (
    <OperationCardShell>
      <ConflictSummaryBody {...props} />
    </OperationCardShell>
  )
}

// Why: separate from ConflictSummaryCard because a rebase/merge/cherry-pick can be in progress with no conflicts (between steps, or resolved but pre-continue).
export function OperationBannerBody({
  conflictOperation,
  sourceControlAiActionsVisible = false,
  isResolvingWithAI = false,
  isAbortingOperation = false,
  isAdvancingOperation = false,
  operationProgress = null,
  onAbortOperation,
  onContinueOperation,
  onResolveWithAI
}: Partial<SharedOperationCardProps> & {
  conflictOperation: GitConflictOperation
  operationProgress?: GitOperationProgress | null
  onResolveWithAI?: () => void
}): React.JSX.Element {
  const Icon = conflictOperation === 'rebase' ? GitPullRequestArrow : GitMerge
  const onto = shortenOnto(operationProgress?.onto?.trim())
  const heading =
    conflictOperation === 'rebase' && onto
      ? translate(
          'auto.components.right.sidebar.source.control.conflict.status.cards.d047be3812',
          'Rebasing onto {{value0}}',
          { value0: onto }
        )
      : inProgressHeading(conflictOperation)

  return (
    <>
      <div className="flex items-center justify-center gap-2">
        <Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={heading}>
          {heading}
        </span>
      </div>
      <SourceControlOperationBannerActions
        conflictOperation={conflictOperation}
        sourceControlAiActionsVisible={sourceControlAiActionsVisible}
        isResolvingWithAI={isResolvingWithAI}
        isAbortingOperation={isAbortingOperation}
        isAdvancingOperation={isAdvancingOperation}
        onAbortOperation={onAbortOperation}
        onContinueOperation={onContinueOperation}
        onResolveWithAI={onResolveWithAI}
      />
    </>
  )
}

/** Standalone card; see ConflictSummaryCard for why the panel does not use this directly. */
export function OperationBanner(
  props: React.ComponentProps<typeof OperationBannerBody>
): React.JSX.Element {
  return (
    <OperationCardShell>
      <OperationBannerBody {...props} />
    </OperationCardShell>
  )
}
