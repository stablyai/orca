import type React from 'react'
import { useCallback } from 'react'
import { shouldForcePushWithLeaseForUpstream } from '../../../../../../shared/git-upstream-status'
import type { DropdownActionKind } from '../../source-control-dropdown-item-types'
import type { SourceControlCommitAction } from '../commit/use-commit-action'
import { handleSourceControlCommitShortcut } from '../commit/commit-shortcut'
import type { SourceControlFileListing } from '../listing/use-file-listing'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlConflictAbort } from '../sync/use-conflict-abort'
import type { SourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import type { SourceControlActionModel } from './use-action-model'
import type { SourceControlHostedReviewCreation } from './use-hosted-review-creation'

/**
 * Routes the primary button, the dropdown, the header Create-review affordance and the commit
 * shortcut to one shared dispatcher, so every entry point obeys the same in-flight guard.
 */
export function useSourceControlActionDispatch({
  createPrHeaderAction,
  handleAbortMerge,
  handleAbortRebase,
  handleCommit,
  handleCreatePullRequest,
  handleStageAllPrimary,
  isCreatePrIntentInFlight,
  isCreatingPr,
  primaryAction,
  prGenerating,
  remoteStatus,
  remoteStatusForActions,
  runCompoundCommitAction,
  runCreatePrIntent,
  runRemoteAction
}: {
  createPrHeaderAction: SourceControlActionModel['createPrHeaderAction']
  handleAbortMerge: SourceControlConflictAbort['handleAbortMerge']
  handleAbortRebase: SourceControlConflictAbort['handleAbortRebase']
  handleCommit: SourceControlCommitAction['handleCommit']
  handleCreatePullRequest: SourceControlHostedReviewCreation['handleCreatePullRequest']
  handleStageAllPrimary: SourceControlFileListing['handleStageAllPrimary']
  isCreatePrIntentInFlight: boolean
  isCreatingPr: boolean
  primaryAction: SourceControlActionModel['primaryAction']
  prGenerating: boolean
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  remoteStatusForActions: SourceControlWorktreeContext['remoteStatus']
  runCompoundCommitAction: SourceControlRemoteActionRunner['runCompoundCommitAction']
  runCreatePrIntent: () => Promise<void>
  runRemoteAction: SourceControlRemoteActionRunner['runRemoteAction']
}) {
  // Dispatch primary + dropdown action kinds to their handlers.
  const handleActionInvoke = useCallback(
    (kind: DropdownActionKind): void => {
      if (prGenerating || isCreatingPr || isCreatePrIntentInFlight) {
        return
      }
      switch (kind) {
        case 'commit':
          void handleCommit()
          return
        case 'commit_push':
          void runCompoundCommitAction('push')
          return
        case 'commit_sync':
          void runCompoundCommitAction('sync')
          return
        case 'abort_merge':
          void handleAbortMerge()
          return
        case 'abort_rebase':
          void handleAbortRebase()
          return
        case 'create_pr':
          void handleCreatePullRequest()
          return
        case 'push_create_pr':
          void runCreatePrIntent()
          return
        case 'push':
        case 'force_push':
        case 'pull':
        case 'fast_forward':
        case 'sync':
        case 'fetch':
        case 'publish':
        case 'rebase_base':
          void runRemoteAction(kind === 'rebase_base' ? 'rebase' : kind)
      }
    },
    [
      handleCommit,
      handleCreatePullRequest,
      handleAbortMerge,
      handleAbortRebase,
      isCreatingPr,
      isCreatePrIntentInFlight,
      prGenerating,
      runCreatePrIntent,
      runCompoundCommitAction,
      runRemoteAction
    ]
  )

  // Why: 'stage' routes to a primary-only handler since handleActionInvoke is typed to DropdownActionKind (compound commit_* kinds are dropdown-only).
  const handlePrimaryClick = useCallback((): void => {
    switch (primaryAction.kind) {
      case 'stage':
        void handleStageAllPrimary()
        return
      case 'push':
        // Why: primary labels "Force Push" but keeps kind 'push', so invoke the explicit force path when lease force is required.
        handleActionInvoke(
          shouldForcePushWithLeaseForUpstream(remoteStatusForActions ?? remoteStatus)
            ? 'force_push'
            : 'push'
        )
        return
      case 'commit':
      case 'pull':
      case 'sync':
      case 'publish':
      case 'create_pr':
        handleActionInvoke(primaryAction.kind)
        return
      case 'create_pr_intent':
        void runCreatePrIntent()
    }
  }, [
    handleActionInvoke,
    handleStageAllPrimary,
    primaryAction.kind,
    remoteStatus,
    remoteStatusForActions,
    runCreatePrIntent
  ])

  const handleSourceControlKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      handleSourceControlCommitShortcut(event, primaryAction, handlePrimaryClick)
    },
    [handlePrimaryClick, primaryAction]
  )

  const handleCreatePrHeaderClick = useCallback((): void => {
    if (!createPrHeaderAction || createPrHeaderAction.disabled) {
      return
    }
    if (createPrHeaderAction.kind === 'create_pr') {
      void handleCreatePullRequest()
      return
    }
    if (createPrHeaderAction.kind === 'create_pr_intent') {
      void runCreatePrIntent()
    }
  }, [createPrHeaderAction, handleCreatePullRequest, runCreatePrIntent])

  return {
    handleActionInvoke,
    handleCreatePrHeaderClick,
    handlePrimaryClick,
    handleSourceControlKeyDown
  }
}

export type SourceControlActionDispatch = ReturnType<typeof useSourceControlActionDispatch>
