import React from 'react'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import { getWorktreeCardJiraIssueDisplay } from './worktree-card-jira-issue-display'
import type { WorktreeCardIssueDisplay } from './WorktreeCardMeta'
import {
  coerceWorktreeCardVisibleTitle,
  getWorktreeCardTitleDisplay
} from './worktree-card-title-display'
import { useWorkspaceDeleteModifierPressed } from './workspace-delete-quick-action'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type ReviewDetails = ReturnType<typeof useWorktreeCardReviewDetails>

export function useWorktreeCardLinkedDetails({
  worktree,
  newCardStyle,
  deleteState,
  branch,
  issueEntry,
  linearIssueEntry,
  linearIssueFallbackEntry,
  prDisplay
}: Pick<WorktreeCardProps, 'worktree'> &
  Pick<Foundation, 'newCardStyle' | 'deleteState'> &
  Pick<
    ReviewDetails,
    'branch' | 'issueEntry' | 'linearIssueEntry' | 'linearIssueFallbackEntry' | 'prDisplay'
  >) {
  const issue: IssueInfo | null | undefined = worktree.linkedIssue
    ? issueEntry !== undefined
      ? issueEntry.data
      : undefined
    : null
  const issueDisplay: WorktreeCardIssueDisplay | null =
    issue ??
    (worktree.linkedIssue
      ? {
          number: worktree.linkedIssue,
          // Why: linked metadata persists immediately but GitHub details arrive async; show the link number so it doesn't look unlinked.
          title: issue === null ? 'Issue details unavailable' : 'Loading issue...'
        }
      : null)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearIssue: LinearIssue | null | undefined = worktree.linkedLinearIssue
    ? (linearIssueEntry?.data ?? linearIssueFallbackEntry?.data)
    : null

  // Why: build a fallback Linear URL from org key + identifier while full issue data is still loading, so the link stays navigable.
  const linearOrgUrlKey = linearStatus?.viewer?.organizationUrlKey
  const linearWorkspaceUrlKeys = linearStatus?.workspaces?.map((ws) => ({
    id: ws.id,
    organizationUrlKey: ws.organizationUrlKey
  }))
  const linearIssueUrlFallback = React.useMemo(() => {
    if (!worktree.linkedLinearIssue || linearIssue?.url) {
      return undefined
    }

    // Try to get the orgUrlKey from the issue's workspace if we have workspaceId
    let orgUrlKey: string | undefined
    if (linearIssue?.workspaceId && linearWorkspaceUrlKeys) {
      const issueWorkspace = linearWorkspaceUrlKeys.find((ws) => ws.id === linearIssue.workspaceId)
      orgUrlKey = issueWorkspace?.organizationUrlKey
    }

    // Fall back to current viewer's org if no workspace match
    if (!orgUrlKey) {
      orgUrlKey = linearOrgUrlKey
    }

    if (!orgUrlKey) {
      return undefined
    }

    return `https://linear.app/${encodeURIComponent(orgUrlKey)}/issue/${encodeURIComponent(worktree.linkedLinearIssue)}`
  }, [
    worktree.linkedLinearIssue,
    linearIssue?.url,
    linearIssue?.workspaceId,
    linearOrgUrlKey,
    linearWorkspaceUrlKeys
  ])

  const linearIssueDisplay = worktree.linkedLinearIssue
    ? linearIssue
      ? {
          identifier: linearIssue.identifier,
          title: linearIssue.title,
          url: linearIssue.url,
          stateName: linearIssue.state?.name,
          labels: linearIssue.labels
        }
      : {
          identifier: worktree.linkedLinearIssue,
          title:
            linearIssueEntry || linearIssueFallbackEntry
              ? 'Linear issue details unavailable'
              : 'Loading Linear issue...',
          url: linearIssueUrlFallback
        }
    : null
  const jiraIssueDisplay = getWorktreeCardJiraIssueDisplay(worktree)
  const cardTitleDisplay = getWorktreeCardTitleDisplay({
    storedDisplayName: worktree.displayName,
    branchName: branch,
    linearIssueTitle: linearIssueDisplay?.title,
    jiraIssueTitle: jiraIssueDisplay?.title,
    issueTitle: issueDisplay?.title,
    reviewTitle: prDisplay?.title
  })
  const legacyCardTitleDisplay = coerceWorktreeCardVisibleTitle(worktree.displayName)
  const visibleCardTitle = newCardStyle ? cardTitleDisplay : legacyCardTitleDisplay
  const isDeleting = deleteState?.isDeleting ?? false
  const isQueuedForDeletion = deleteState?.phase === 'queued'
  const deleteLabel = isQueuedForDeletion
    ? translate('auto.components.sidebar.WorktreeCard.ef18787206', 'Queued for deletion')
    : translate('auto.components.sidebar.WorktreeCard.691ccfd622', 'Deleting…')
  const deleteModifierPressed = useWorkspaceDeleteModifierPressed()

  return {
    issueDisplay,
    linearIssue,
    linearIssueDisplay,
    jiraIssueDisplay,
    visibleCardTitle,
    isDeleting,
    isQueuedForDeletion,
    deleteLabel,
    deleteModifierPressed
  }
}
