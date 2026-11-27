import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { continueRuntimeGitRebase } from '@/runtime/source-control/git/runtime-git-rebase-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type { ContinueRebaseResult } from '../../../../../../shared/git/status/git-status-types'
import type { RebaseStopReading } from '../panel/worktree-operation-store'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
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
export async function inspectRebaseStop(
  context: RuntimeGitContext,
  operationStore: OperationStore,
  statusHead: string | null,
  emptyObservation: string | null,
  emptyStop: RebaseStopReading | null,
  isCurrent: () => boolean
) {
  try {
    const result = await continueRuntimeGitRebase(context, 'inspect')
    // A reading superseded by a newer HEAD's inspection must not overwrite that one.
    if (isCurrent()) {
      if (result.outcome === 'failed') {
        operationStore.setState({
          ...(emptyObservation ? {} : { rebaseStop: null }),
          rebaseStopInspectFailure: { head: statusHead, message: result.message ?? null }
        })
      } else if (emptyObservation && result.outcome === 'inspected') {
        if (
          !result.indexObservation ||
          result.hasStagedChanges === undefined ||
          result.indexObservation !== emptyObservation
        ) {
          operationStore.setState({
            rebaseStopInspectFailure: { head: statusHead, message: null }
          })
        } else {
          const token = result.stop
          const previous = emptyStop?.token
          const sameStop =
            token &&
            previous &&
            token.head === previous.head &&
            token.step === previous.step &&
            token.incarnation === previous.incarnation
          recordRebaseStopReading(
            operationStore,
            !sameStop || result.hasStagedChanges ? result : { ...result, outcome: 'empty' }
          )
        }
      } else {
        recordRebaseStopReading(operationStore, result)
      }
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

export async function runContinueRequest({
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
