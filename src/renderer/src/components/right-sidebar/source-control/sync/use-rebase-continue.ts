import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { continueRuntimeGitRebase } from '@/runtime/source-control/git/runtime-git-rebase-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type {
  ContinueRebaseResult,
  GitConflictOperation
} from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { recordRebaseStopReading } from './orca-rebase-marker'

type OperationStore = SourceControlWorktreeOperationState['operationStore']

function continueFailureTitle(): string {
  return translate(
    'auto.components.right.sidebar.SourceControl.continueRebaseFailed',
    'Continue rebase failed'
  )
}

// Only a completed outcome reads as success; every other stop keeps the paused strip and says why.
function announceRebaseStep(result: ContinueRebaseResult): void {
  switch (result.outcome) {
    case 'completed':
    case 'inspected':
      return
    case 'completed_autostash_conflict':
      toast.warning(
        translate(
          'auto.components.right.sidebar.SourceControl.rebaseAutostashConflict',
          "Rebased. Your uncommitted changes didn't reapply cleanly; they're saved in the stash."
        )
      )
      return
    case 'conflicted':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.continueRebasePausedAgain',
          'Rebase paused at the next conflict'
        )
      )
      return
    case 'empty':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.rebaseEmptyStep',
          'Nothing to commit in this step. Abort the rebase or finish it in a terminal.'
        )
      )
      return
    case 'stopped':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.rebaseStoppedByGit',
          'Git paused the rebase'
        ),
        { description: result.message }
      )
      return
    case 'not_rebasing':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.noRebaseInProgress',
          'No rebase is in progress'
        )
      )
      return
    case 'stale':
      toast.error(continueFailureTitle(), {
        description: translate(
          'auto.components.right.sidebar.SourceControl.rebaseStopMovedOn',
          'The rebase already moved on. Check the panel and try again.'
        )
      })
      return
    case 'failed':
      toast.error(continueFailureTitle(), { description: result.message })
  }
}

// Module-level so the hooks stay React Compiler friendly (no try/finally inside them).
async function inspectRebaseStop(
  context: RuntimeGitContext,
  operationStore: OperationStore,
  statusHead: string | null,
  isCurrent: () => boolean
) {
  try {
    const result = await continueRuntimeGitRebase(context, 'inspect')
    // A reading superseded by a newer HEAD's inspection must not overwrite that one.
    if (isCurrent()) {
      recordRebaseStopReading(operationStore, result)
    }
  } catch (error) {
    // A stopped WSL distro, an RPC blip or an older host: without this, Continue would sit disabled
    // with no reason. The failure is pinned to this HEAD; a HEAD move or Retry reads again.
    if (isCurrent()) {
      operationStore.setState({
        rebaseStopInspectFailure: {
          head: statusHead,
          message: error instanceof Error && error.message ? error.message : null
        }
      })
    }
  }
}

async function runContinueRequest({
  context,
  operationStore,
  refresh
}: {
  context: RuntimeGitContext
  operationStore: OperationStore
  refresh: () => void
}): Promise<void> {
  const expected = operationStore.getState().rebaseStop?.token
  try {
    const result = await continueRuntimeGitRebase(context, 'continue', { expected })
    recordRebaseStopReading(operationStore, result)
    announceRebaseStep(result)
  } catch (error) {
    // A transport timeout leaves the host's result unknown; re-read the stop before any retry.
    operationStore.setState({ rebaseStop: null })
    toast.error(continueFailureTitle(), {
      description:
        error instanceof Error && error.message
          ? error.message
          : translate(
              'auto.components.right.sidebar.SourceControl.continueRebaseUnconfirmed',
              "Couldn't confirm the result. Source Control refreshed to show the current state."
            )
    })
  } finally {
    operationStore.setState({ isAbortingOperation: false, isContinuingRebase: false })
    refresh()
  }
}

export function useSourceControlRebaseContinue({
  activeRepoTarget,
  activeWorktreeId,
  conflictOperation,
  operationStore,
  rebaseStopUnread,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  statusHead,
  stagedSignature,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  operationStore: OperationStore
  // The paused rebase has no reading for the current HEAD yet.
  rebaseStopUnread: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  // The HEAD status reports; a move while still unread starts a fresh inspection.
  statusHead: string | null
  stagedSignature: string
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const [isRetryingRebaseInspect, setIsRetryingRebaseInspect] = useState(false)
  const previousStaged = useRef(stagedSignature)
  useEffect(() => {
    const changed = previousStaged.current !== stagedSignature
    previousStaged.current = stagedSignature
    if (changed && operationStore.getState().rebaseStop?.blocked === 'empty') {
      operationStore.setState({ rebaseStop: null })
    }
  }, [operationStore, stagedSignature])
  const shouldInspect = conflictOperation === 'rebase' && rebaseStopUnread
  useEffect(() => {
    // An unresolved owner has no host to ask; requireGitOwnerTarget below would throw out of the effect.
    if (!shouldInspect || !activeRepoTarget || !activeWorktreeId || !worktreePath) {
      return
    }
    let current = true
    void inspectRebaseStop(
      {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      },
      operationStore,
      statusHead,
      () => current
    ).finally(() => setIsRetryingRebaseInspect(false))
    return () => {
      current = false
    }
  }, [
    activeRepoTarget,
    activeWorktreeId,
    operationStore,
    scope,
    shouldInspect,
    statusHead,
    worktreePath
  ])

  // Continue only the complete stop that was shown.
  const runRebaseStep = useCallback(async (): Promise<void> => {
    const state = operationStore.getState()
    // Admit only with a resolved owner: requireGitOwnerTarget runs after the lock is taken, outside
    // runContinueRequest's finally, so a throw there would leave Continue and Abort locked.
    if (
      !activeRepoTarget ||
      !activeWorktreeId ||
      !worktreePath ||
      conflictOperation !== 'rebase' ||
      state.isAbortingOperation ||
      !state.rebaseStop ||
      state.rebaseStop.blocked !== null ||
      !state.rebaseStop.token.head ||
      !state.rebaseStop.token.step ||
      !state.rebaseStop.token.incarnation
    ) {
      return
    }
    // isAbortingOperation is the shared conflict-operation lock that Abort and the busy gates read.
    operationStore.setState({
      isAbortingOperation: true,
      isContinuingRebase: true,
      remoteActionError: null
    })
    await runContinueRequest({
      context: {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      },
      operationStore,
      refresh: () =>
        refreshSourceControlAfterRemoteAction({
          worktreeId: activeWorktreeId,
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
    })
  }, [
    scope,
    activeRepoTarget,
    activeWorktreeId,
    conflictOperation,
    operationStore,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    worktreePath
  ])
  const handleContinueRebase = runRebaseStep
  // Clearing the failure makes the stop unread again, which re-runs the inspect effect above.
  const handleRetryRebaseInspect = useCallback((): void => {
    setIsRetryingRebaseInspect(true)
    operationStore.setState({ rebaseStop: null, rebaseStopInspectFailure: null })
  }, [operationStore])
  return {
    handleContinueRebase,
    handleRetryRebaseInspect,
    isRetryingRebaseInspect: isRetryingRebaseInspect && shouldInspect && !!activeRepoTarget
  }
}

export type SourceControlRebaseContinue = ReturnType<typeof useSourceControlRebaseContinue>
