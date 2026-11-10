import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import {
  gitCommitActionsSupported,
  useGitCommitActionsSupport
} from '@/runtime/source-control/git/git-commit-actions-capability'
import {
  sequencerAbortRuntimeGit,
  sequencerContinueRuntimeGit
} from '@/runtime/source-control/git/runtime-git-commit-actions-client'
import '@/lib/source-control/graph/git-graph-tab'
import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/source-control/graph/git-graph-refresh-event'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useSourceControlWorktreeContext } from './use-worktree-context'
import type { GitCommitAction } from '../../../../../../shared/git/commands/git-commit-action'
import { useAppStore } from '@/store'
import { resolveWorktreeGitCopyNow, worktreeCopyPushTarget } from '@/lib/worktree-git-copy'

async function runSequencerRecovery(run: () => Promise<void>, refresh: () => void) {
  try {
    await run()
  } finally {
    refresh()
  }
}

export function SequencerRecoveryControls({
  worktreeId,
  operation,
  disabled
}: {
  worktreeId: string
  operation: GitCommitAction
  disabled: boolean
}) {
  const t = useTranslate()
  const context = useSourceControlWorktreeContext()
  const { supported, reason } = useGitCommitActionsSupport(
    context.activeRepoTarget,
    context.activeRepoExecutionHostId ?? undefined
  )
  const operationLabel =
    operation === 'revert'
      ? t('gitGraph.revert', 'Revert')
      : t('gitGraph.cherryPick', 'Cherry-pick')
  const confirm = useConfirmationDialog()
  const [busy, setBusy] = useState(false)
  const navigation = useRef(0)
  useEffect(() => {
    const invalidate = () => {
      navigation.current++
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId
      ) {
        invalidate()
      }
    })
    return () => {
      invalidate()
      unsubscribe()
    }
  }, [])
  const run = async (action: 'abort' | 'continue') => {
    const copy = resolveWorktreeGitCopyNow(worktreeId)
    const target = copy?.transport
    const path = context.worktreePath
    if (busy || disabled || !copy || !target || !path || context.activeWorktreeId !== worktreeId) {
      return
    }
    const generation = navigation.current
    const shouldApply = () =>
      generation === navigation.current &&
      useAppStore.getState().activeWorktreeId === worktreeId &&
      JSON.stringify(resolveWorktreeGitCopyNow(worktreeId)) === JSON.stringify(copy)
    if (
      action === 'abort' &&
      !(await confirm({
        title: t('gitGraph.abortOperationTitle', 'Abort {{operation}}?', {
          operation: operationLabel
        }),
        description: t(
          'gitGraph.abortOperationDescription',
          'This cancels the operation in progress and can discard conflict resolutions made during it.'
        ),
        confirmLabel: t('gitGraph.abortOperation', 'Abort {{operation}}', {
          operation: operationLabel
        }),
        confirmVariant: 'destructive'
      }))
    ) {
      return
    }
    setBusy(true)
    await runSequencerRecovery(
      async () => {
        try {
          if (!(await gitCommitActionsSupported(target)) || !shouldApply()) {
            return
          }
          const request = {
            target,
            worktreeId,
            worktreePath: path,
            connectionId: copy.connectionId
          }
          const result = await (
            action === 'abort' ? sequencerAbortRuntimeGit : sequencerContinueRuntimeGit
          )(request, operation)
          if (result?.outcome === 'empty') {
            toast.message(
              operation === 'revert'
                ? t(
                    'gitGraph.nothingToRevert',
                    'Nothing to revert; the changes are already undone.'
                  )
                : t('gitGraph.alreadyApplied', 'Already applied, nothing to cherry-pick')
            )
          }
        } catch (error) {
          toast.error(
            extractIpcErrorMessage(
              error,
              t(
                'gitGraph.recoveryFailed',
                'Could not finish the operation. Refresh Source Control and try again.'
              )
            )
          )
        }
      },
      () => {
        setBusy(false)
        const state = useAppStore.getState()
        if (shouldApply()) {
          void refreshGitStatusForWorktree({
            worktreeId,
            worktreePath: path,
            target,
            connectionId: copy.connectionId,
            ownerHostId: copy.hostId,
            pushTarget: worktreeCopyPushTarget(state, worktreeId, copy.hostId),
            deps: state,
            request: { shouldApply }
          }).catch(() => {})
        }
        window.dispatchEvent(new CustomEvent(GIT_GRAPH_REFRESH_EVENT, { detail: worktreeId }))
      }
    )
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
        {t('gitGraph.continueOperation', 'Continue {{operation}}', {
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
        {t('gitGraph.abortOperation', 'Abort {{operation}}', { operation: operationLabel })}
      </Button>
    </div>
  )
}
