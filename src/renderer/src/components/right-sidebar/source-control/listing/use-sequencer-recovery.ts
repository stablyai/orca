import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import {
  gitCommitActionsSupported,
  useGitCommitActionsSupport
} from '@/runtime/source-control/git/git-commit-actions-capability'
import {
  sequencerAbortRuntimeGit,
  sequencerContinueRuntimeGit
} from '@/runtime/source-control/git/runtime-git-commit-actions-client'
import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/source-control/graph/git-graph-refresh-event'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { useSourceControlWorktreeContext } from './use-worktree-context'
import { toastIfOperationRunChanged } from '../sync/operation-run-changed-toast'
import type { GitCommitAction } from '../../../../../../shared/git/commands/git-commit-action'
import { useAppStore } from '@/store/index'
import {
  resolveWorktreeGitCopyNow,
  worktreeCopyPushTarget
} from '@/lib/workspace/ownership/worktree-git-copy'

async function runSequencerRecovery(run: () => Promise<void>, refresh: () => void) {
  try {
    await run()
  } finally {
    refresh()
  }
}

/** Continue/Abort for a paused cherry-pick or revert; abort asks first unless the caller already did. */
export function useSequencerRecovery({
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
  const [busyAction, setBusyAction] = useState<'abort' | 'continue' | null>(null)
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
  const run = async (
    action: 'abort' | 'continue',
    // expectedRunIdentity: the run an in-place confirm was for; the abort refuses on another run.
    {
      confirmed = false,
      expectedRunIdentity
    }: { confirmed?: boolean; expectedRunIdentity?: string } = {}
  ) => {
    const copy = resolveWorktreeGitCopyNow(worktreeId)
    const target = copy?.transport
    const path = context.worktreePath
    if (
      busyAction ||
      disabled ||
      !copy ||
      !target ||
      !path ||
      context.activeWorktreeId !== worktreeId
    ) {
      return
    }
    const generation = navigation.current
    const shouldApply = () =>
      generation === navigation.current &&
      useAppStore.getState().activeWorktreeId === worktreeId &&
      JSON.stringify(resolveWorktreeGitCopyNow(worktreeId)) === JSON.stringify(copy)
    if (
      action === 'abort' &&
      !confirmed &&
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
    setBusyAction(action)
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
          const result =
            action === 'abort'
              ? await sequencerAbortRuntimeGit(request, operation, { expectedRunIdentity })
              : await sequencerContinueRuntimeGit(request, operation)
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
          if (toastIfOperationRunChanged(error)) {
            return
          }
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
        setBusyAction(null)
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
  return { supported, reason, busyAction, run }
}
