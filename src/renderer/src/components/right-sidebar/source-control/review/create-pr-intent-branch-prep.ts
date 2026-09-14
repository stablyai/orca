import { translate } from '@/i18n/i18n'
import { isBehindOnlyUpstream } from '../../../../../../shared/git-upstream-status'
import { readCommitDraftForWorktree, writeCommitDraftForWorktree } from '../commit/commit-drafts'
import {
  getCreatePrIntentCommitFailureNoticeMessage,
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlCommitAction } from '../commit/use-commit-action'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import type { CreatePrIntentRunSnapshot } from './create-pr-intent-run-snapshot'
import type { SourceControlCreatePrIntentCommitMessage } from './use-create-pr-intent-commit-message'

/**
 * Gets the branch to a committed, ff-current state before eligibility is read. Returns false when
 * the intent must stop — the caller has nothing left to clean up beyond its own finally block.
 */
export async function runCreatePrIntentBranchPrep({
  commitDraftsRef,
  commitErrorsRef,
  generateCommitMessageForCreatePrIntent,
  handleCommit,
  operationTarget,
  runRemoteAction,
  setCreatePrIntentNoticeForWorktree,
  snapshot,
  token,
  updateCommitDrafts
}: {
  commitDraftsRef: SourceControlWorktreeOperationState['commitDraftsRef']
  commitErrorsRef: SourceControlWorktreeOperationState['commitErrorsRef']
  generateCommitMessageForCreatePrIntent: SourceControlCreatePrIntentCommitMessage['generateCommitMessageForCreatePrIntent']
  handleCommit: SourceControlCommitAction['handleCommit']
  operationTarget: SourceControlOperationTarget
  runRemoteAction: SourceControlRemoteActionRunner['runRemoteAction']
  setCreatePrIntentNoticeForWorktree: SourceControlWorktreeOperationState['setCreatePrIntentNoticeForWorktree']
  snapshot: CreatePrIntentRunSnapshot
  token: CreatePrIntentRunToken
  updateCommitDrafts: SourceControlWorktreeOperationState['updateCommitDrafts']
}): Promise<boolean> {
  const { abortIfStale, refreshIntentSnapshot, stageLatestIntentPaths } = snapshot

  if (!(await refreshIntentSnapshot())) {
    return false
  }

  // Why: fast-forward behind-only before commit so a dirty worktree can't become ahead+behind and dead-end at the sync-first stop; --ff-only never auto-merges.
  if (isBehindOnlyUpstream(snapshot.upstreamStatus)) {
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
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
      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
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

  let message = readCommitDraftForWorktree(commitDraftsRef.current, token.worktreeId).trim()
  if (!message) {
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
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
      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
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
    const draftAfterGeneration = readCommitDraftForWorktree(
      commitDraftsRef.current,
      token.worktreeId
    ).trim()
    if (draftAfterGeneration) {
      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
        tone: 'muted',
        message: translate(
          'auto.components.right.sidebar.SourceControl.fda060d6ce',
          'Review the commit message, then retry Create PR.'
        )
      })
      return false
    }
    message = generated.message
    updateCommitDrafts((prev) => writeCommitDraftForWorktree(prev, token.worktreeId, message))
  }

  setCreatePrIntentNoticeForWorktree(token.worktreeId, {
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
    // Why: pre-commit/lint hooks may rewrite tracked files before failing; re-stage those outputs so retrying Create PR doesn't strand changes.
    if (await refreshIntentSnapshot()) {
      await stageLatestIntentPaths()
    }
    if (abortIfStale()) {
      return false
    }
    const commitFailure = commitErrorsRef.current[token.worktreeId] ?? null
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
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
