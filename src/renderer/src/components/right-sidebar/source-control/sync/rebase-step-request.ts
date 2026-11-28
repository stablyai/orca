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

/** Re-read a stop whose readiness rests on the index: an empty step, or one ready only because of staging. */
export type RebaseStopRecheck = {
  stop: RebaseStopReading
  // The index status reports now; null when the host reports none, which can never confirm the step.
  observation: string | null
}

// Module-level so the hooks stay React Compiler friendly (no try/finally inside them).
// Returns the head the host read, or null when nothing was accepted.
export async function inspectRebaseStop(
  context: RuntimeGitContext,
  operationStore: OperationStore,
  statusHead: string | null,
  recheck: RebaseStopRecheck | null,
  isCurrent: () => boolean
): Promise<string | null> {
  try {
    const result = await continueRuntimeGitRebase(context, 'inspect')
    // A reading superseded by a newer HEAD's inspection must not overwrite that one.
    if (!isCurrent()) {
      return null
    }
    if (result.outcome === 'failed') {
      operationStore.setState({
        ...(recheck ? {} : { rebaseStop: null }),
        rebaseStopInspectFailure: { head: statusHead, message: result.message ?? null }
      })
      return null
    }
    if (!recheck || result.outcome !== 'inspected') {
      recordRebaseStopReading(operationStore, result)
      return result.stop?.head ?? null
    }
    if (
      !recheck.observation ||
      !result.indexObservation ||
      result.hasStagedChanges === undefined ||
      result.indexObservation !== recheck.observation
    ) {
      operationStore.setState({ rebaseStopInspectFailure: { head: statusHead, message: null } })
      return null
    }
    const token = result.stop
    const previous = recheck.stop.token
    const sameStop =
      token &&
      token.head === previous.head &&
      token.step === previous.step &&
      token.incarnation === previous.incarnation
    if (!sameStop) {
      recordRebaseStopReading(operationStore, result)
    } else if (result.hasStagedChanges) {
      // Ready only while this index stands; a later change (an unstage) reads the step again.
      recordRebaseStopReading(operationStore, result, true)
    } else {
      recordRebaseStopReading(operationStore, { ...result, outcome: 'empty' })
    }
    return result.stop?.head ?? null
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
    return null
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
