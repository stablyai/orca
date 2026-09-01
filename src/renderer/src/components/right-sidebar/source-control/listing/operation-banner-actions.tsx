import React from 'react'
import { GitMerge, Play, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'

export type SourceControlOperationActionProps = {
  conflictOperation: GitConflictOperation
  hasUnresolvedConflicts?: boolean
  sourceControlAiActionsVisible?: boolean
  isResolvingWithAI?: boolean
  isAbortingOperation?: boolean
  isAdvancingOperation?: boolean
  onAbortOperation?: (operation: GitConflictOperation) => void
  onContinueOperation?: (operation: GitConflictOperation) => void
  onResolveWithAI?: () => void
  onReviewConflicts?: () => void
}

function continueLabel(operation: GitConflictOperation): string {
  if (operation === 'merge') {
    return translate('components.sourceControl.operationBanner.continueMerge', 'Continue merge')
  }
  if (operation === 'cherry-pick') {
    return translate(
      'components.sourceControl.operationBanner.continueCherryPick',
      'Continue cherry-pick'
    )
  }
  return translate('components.sourceControl.operationBanner.continueRebase', 'Continue rebase')
}

function abortLabel(operation: GitConflictOperation): string {
  return operation === 'rebase'
    ? translate('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
    : translate('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')
}

type OperationAction = {
  key: string
  label: string
  icon: React.JSX.Element | null
  onClick: () => void
  // Escape hatches never take the primary slot, so they never read as a way forward.
  quiet?: boolean
  // Read-only navigation stays clickable while a mutation is in flight.
  enabledWhileBusy?: boolean
}

const SPINNER = <RefreshCw className="size-3.5 animate-spin" />

/**
 * One button per row: a single `default` primary over outlined alternatives. Order below
 * is the priority order — whichever action is available first takes the primary slot.
 */
export function SourceControlOperationBannerActions({
  conflictOperation,
  hasUnresolvedConflicts = false,
  sourceControlAiActionsVisible = false,
  isResolvingWithAI = false,
  isAbortingOperation = false,
  isAdvancingOperation = false,
  onAbortOperation,
  onContinueOperation,
  onResolveWithAI,
  onReviewConflicts
}: SourceControlOperationActionProps): React.JSX.Element | null {
  // Why: git refuses `--continue` while any file is still unmerged, so offering it
  // during conflicts is offering a button that can only fail.
  const continueAvailable = Boolean(onContinueOperation) && !hasUnresolvedConflicts
  const busy = isResolvingWithAI || isAbortingOperation || isAdvancingOperation

  const actions: OperationAction[] = []
  if (continueAvailable) {
    actions.push({
      key: 'continue',
      label: continueLabel(conflictOperation),
      icon: isAdvancingOperation ? SPINNER : <Play className="size-3.5" />,
      onClick: () => onContinueOperation?.(conflictOperation)
    })
  }
  if (sourceControlAiActionsVisible && onResolveWithAI) {
    actions.push({
      key: 'resolve-with-ai',
      label: translate('auto.components.right.sidebar.SourceControl.f6cb48b6fe', 'Resolve with AI'),
      icon: isResolvingWithAI ? SPINNER : <Sparkles className="size-3.5" />,
      onClick: onResolveWithAI
    })
  }
  if (onReviewConflicts && hasUnresolvedConflicts) {
    actions.push({
      key: 'review',
      label: translate(
        'auto.components.right.sidebar.SourceControl.27a50fe970',
        'Review conflicts'
      ),
      icon: <GitMerge className="size-3.5" />,
      onClick: onReviewConflicts,
      enabledWhileBusy: true
    })
  }
  if ((conflictOperation === 'merge' || conflictOperation === 'rebase') && onAbortOperation) {
    actions.push({
      key: 'abort',
      label: abortLabel(conflictOperation),
      icon: isAbortingOperation ? SPINNER : null,
      onClick: () => onAbortOperation(conflictOperation),
      quiet: true
    })
  }

  // Why: a quiet action is never promoted — abort alone stays outlined rather than
  // becoming the loudest thing in the card by default.
  const primary = actions.find((action) => !action.quiet) ?? null
  if (actions.length === 0) {
    return null
  }

  const render = (action: OperationAction, variant: 'default' | 'outline'): React.JSX.Element => (
    <Button
      key={action.key}
      type="button"
      variant={variant}
      size="sm"
      className="h-7 w-full min-w-0 text-xs"
      disabled={busy && !action.enabledWhileBusy}
      onClick={action.onClick}
    >
      {action.icon}
      <span className="truncate">{action.label}</span>
    </Button>
  )

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {actions.map((action) => render(action, action === primary ? 'default' : 'outline'))}
    </div>
  )
}
