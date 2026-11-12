import { translate } from '@/i18n/i18n'
import { isBehindOnlyUpstream } from '../../../../../../shared/git/remotes/git-upstream-status'
import {
  getCreatePrIntentCommitFailureNoticeMessage,
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlCommitAction } from '../commit/use-commit-action'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { CreatePrIntentNotice } from '../commit/commit-area-types'
import type { SourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import type { CreatePrIntentRunSnapshot } from './create-pr-intent-run-snapshot'
import type { SourceControlCreatePrIntentCommitMessage } from './use-create-pr-intent-commit-message'

/** Prepare a committed fast-forward-current branch; false stops the intent with only caller finally cleanup remaining. */
export async function runCreatePrIntentBranchPrep({
  generateCommitMessageForCreatePrIntent,
  handleCommit,
  operationStore,
  operationTarget,
  runRemoteAction,
  setCreatePrIntentNotice,
  snapshot,
  token,
  updateCommitDraft
}: {
  generateCommitMessageForCreatePrIntent: SourceControlCreatePrIntentCommitMessage['generateCommitMessageForCreatePrIntent']
  handleCommit: SourceControlCommitAction['handleCommit']
  operationStore: SourceControlWorktreeOperationState['operationStore']
  operationTarget: SourceControlOperationTarget
  runRemoteAction: SourceControlRemoteActionRunner['runRemoteAction']
  setCreatePrIntentNotice: (notice: CreatePrIntentNotice | null) => void
  snapshot: CreatePrIntentRunSnapshot
  token: CreatePrIntentRunToken
  updateCommitDraft: SourceControlWorktreeOperationState['updateCommitDraft']
}): Promise<boolean> {
  const { abortIfStale, refreshIntentSnapshot, stageLatestIntentPaths } = snapshot

  if (!(await refreshIntentSnapshot())) {
    return false
  }

  // Fast-forward behind-only before commit to avoid creating divergence; ff-only never auto-merges.
  if (isBehindOnlyUpstream(snapshot.upstreamStatus)) {
    setCreatePrIntentNotice({
      tone: 'muted',
      message: translate(
        'auto.components.right.sidebar.SourceControl.createPrIntentFastForwarding',
        'Updating branch…'
      )
    })
    const earlyFfResult = await runRemoteAction('fast_forward', {
      target: operationTarget
    })
    if (abortIfStale()) {
      return false
    }
    if (earlyFfResult.status === 'superseded') {
      return false
    }
    if (earlyFfResult.status !== 'ok') {
      setCreatePrIntentNotice({
        tone: 'destructive',
        message: translate(
          'auto.components.right.sidebar.SourceControl.createPrIntentRemoteFailed',
          'Could not update the remote branch. Retry Create PR.'
        )
      })
      return false
    }
    if (!(await refreshIntentSnapshot())) {
      return false
    }
  }

  if (!(await stageLatestIntentPaths())) {
    return false
  }

  const stagedEntries = snapshot.entries.filter((entry) => entry.area === 'staged')
  if (stagedEntries.length === 0) {
    return true
  }

  let message = operationStore.getState().draft.trim()
  if (!message) {
    setCreatePrIntentNotice({
      tone: 'muted',
      message: translate(
        'auto.components.right.sidebar.SourceControl.8d8f5c6c94',
        'Generating commit message…'
      )
    })
    const generated = await generateCommitMessageForCreatePrIntent(token)
    if (abortIfStale()) {
      return false
    }
    if (!generated.ok || !generated.message) {
      setCreatePrIntentNotice({
        tone: generated.reason === 'settings' ? 'muted' : 'destructive',
        message: translate(
          generated.reason === 'settings'
            ? 'auto.components.right.sidebar.SourceControl.createPrIntentConfigureAi'
            : 'auto.components.right.sidebar.SourceControl.createPrIntentGenerateFailed',
          generated.reason === 'settings'
            ? 'Add a commit message or configure Source Control AI settings.'
            : 'Could not generate a commit message. Add one and retry.'
        ),
        action: generated.reason === 'settings' ? 'settings' : undefined
      })
      return false
    }
    if (operationStore.getState().draft.trim()) {
      setCreatePrIntentNotice({
        tone: 'muted',
        message: translate(
          'auto.components.right.sidebar.SourceControl.fda060d6ce',
          'Review the commit message, then retry Create PR.'
        )
      })
      return false
    }
    message = generated.message
    updateCommitDraft(message)
  }

  setCreatePrIntentNotice({
    tone: 'muted',
    message: translate(
      'auto.components.right.sidebar.SourceControl.b75cb1fd0c',
      'Committing changes…'
    )
  })
  const committed = await handleCommit(message, {
    skipStagedSnapshotCheck: true,
    skipActiveConflictCheck: true,
    target: operationTarget
  })
  if (abortIfStale()) {
    return false
  }
  if (!committed) {
    // Failed hooks may rewrite tracked files; restage their outputs so Create PR retries retain those changes.
    if (await refreshIntentSnapshot()) {
      await stageLatestIntentPaths()
    }
    if (abortIfStale()) {
      return false
    }
    const commitFailure = operationStore.getState().commitError
    setCreatePrIntentNotice({
      tone: 'destructive',
      message: getCreatePrIntentCommitFailureNoticeMessage(commitFailure, {
        fallback: translate(
          'auto.components.right.sidebar.SourceControl.createPrIntentCommitFailed',
          'Could not commit changes. Fix the issue, then retry Create PR.'
        ),
        withSummary: (summary) =>
          translate(
            'auto.components.right.sidebar.SourceControl.createPrIntentCommitBlockedSummary',
            'Commit blocked: {{value0}} Fix the issue, then retry Create PR.',
            { value0: summary }
          )
      })
    })
    return false
  }
  return refreshIntentSnapshot()
}
