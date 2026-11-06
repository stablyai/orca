import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import {
  gitCommitActionsSupported,
  useGitCommitActionsSupport
} from '@/runtime/git-commit-actions-capability'
import {
  sequencerAbortRuntimeGit,
  sequencerContinueRuntimeGit
} from '@/runtime/runtime-git-commit-actions-client'
import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/git-graph-tab'
import { useSourceControlWorktreeContext } from './use-worktree-context'
import type { GitCommitAction } from '../../../../../../shared/git/commands/git-commit-action'
import { useAppStore } from '@/store'

export function SequencerRecoveryControls({
  worktreeId,
  operation,
  disabled
}: {
  worktreeId: string
  operation: GitCommitAction
  disabled: boolean
}) {
  const context = useSourceControlWorktreeContext()
  const { supported, reason } = useGitCommitActionsSupport(
    context.activeRepoTarget,
    context.activeRepoExecutionHostId ?? undefined
  )
  const operationLabel =
    operation === 'revert'
      ? translate('gitGraph.revert', 'Revert')
      : translate('gitGraph.cherryPick', 'Cherry-pick')
  const confirm = useConfirmationDialog()
  const [busy, setBusy] = useState(false)
  const run = async (action: 'abort' | 'continue') => {
    const target = context.activeRepoTarget
    const path = context.worktreePath
    if (busy || disabled || !target || !path || context.activeWorktreeId !== worktreeId) {
      return
    }
    if (
      action === 'abort' &&
      !(await confirm({
        title: translate('gitGraph.abortOperationTitle', 'Abort {{operation}}?', {
          operation: operationLabel
        }),
        description: translate(
          'gitGraph.abortOperationDescription',
          'This cancels the operation in progress and can discard conflict resolutions made during it.'
        ),
        confirmLabel: translate('gitGraph.abortOperation', 'Abort {{operation}}', {
          operation: operationLabel
        }),
        confirmVariant: 'destructive'
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      if (!(await gitCommitActionsSupported(target))) {
        return
      }
      const request = {
        target,
        worktreeId,
        worktreePath: path,
        connectionId: context.activeConnectionId ?? undefined
      }
      await (action === 'abort' ? sequencerAbortRuntimeGit : sequencerContinueRuntimeGit)(
        request,
        operation
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'gitGraph.recoveryFailed',
              'Could not finish the operation. Refresh Source Control and try again.'
            )
      )
    } finally {
      setBusy(false)
      const state = useAppStore.getState()
      void refreshGitStatusForWorktree({
        worktreeId,
        worktreePath: path,
        target,
        connectionId: context.activeConnectionId ?? undefined,
        ownerHostId: context.activeRepoExecutionHostId,
        deps: state
      }).catch(() => {})
      window.dispatchEvent(new CustomEvent(GIT_GRAPH_REFRESH_EVENT, { detail: worktreeId }))
    }
  }
  return (
    <div className="space-y-1.5">
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <Button
        className="h-7 w-full text-xs"
        size="sm"
        disabled={!supported || disabled || busy}
        onClick={() => void run('continue')}
      >
        {translate('gitGraph.continueOperation', 'Continue {{operation}}', {
          operation: operationLabel
        })}
      </Button>
      <Button
        className="h-7 w-full text-xs"
        size="sm"
        variant="outline"
        disabled={!supported || disabled || busy}
        onClick={() => void run('abort')}
      >
        {translate('gitGraph.abortOperation', 'Abort {{operation}}', { operation: operationLabel })}
      </Button>
    </div>
  )
}
