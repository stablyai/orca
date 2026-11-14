import { useTranslate } from '@/i18n/use-translate'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import type { IssueInfo } from '../../../../../../shared/github/pull-requests/pull-request-types'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import { getWorktreeCardJiraIssueDisplay } from '../review/worktree-card-jira-issue-display'
import type { WorktreeCardIssueDisplay } from '../metadata/worktree-card-meta-types'
import {
  coerceWorktreeCardVisibleTitle,
  getWorktreeCardTitleDisplay
} from '../identity/worktree-card-title-display'
import { useWorkspaceDeleteModifierPressed } from '../../workspace-actions/deletion/workspace-delete-quick-action'
import type { WorktreeCardProps } from '../controller/worktree-card-model'
import type { useWorktreeCardFoundation } from '../controller/use-worktree-card-foundation'
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
  const t = useTranslate()
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
          title:
            issue === null
              ? t(
                  'auto.components.sidebar.useWorktreeCardLinkedDetails.issueUnavailable',
                  'Issue details unavailable'
                )
              : t(
                  'auto.components.sidebar.useWorktreeCardLinkedDetails.loadingIssue',
                  'Loading issue...'
                )
        }
      : null)
  const linearIssue: LinearIssue | null | undefined = worktree.linkedLinearIssue
    ? (linearIssueEntry?.data ?? linearIssueFallbackEntry?.data)
    : null

  const linearReferences = getWorkspaceAttachments(worktree).filter(
    (item) =>
      item.provider === 'linear' &&
      (item.identifier ?? item.linearIdentifier) === worktree.linkedLinearIssue
  )
  const linearIssueUrlFallback = linearReferences.length === 1 ? linearReferences[0].url : undefined

  const linearIssueDisplay = worktree.linkedLinearIssue
    ? linearIssue
      ? {
          identifier: linearIssue.identifier,
          title: linearIssue.title,
          url: linearIssue.url,
          stateName: linearIssue.state?.name,
          stateType: linearIssue.state?.type,
          labels: linearIssue.labels
        }
      : {
          identifier: worktree.linkedLinearIssue,
          title:
            linearIssueEntry || linearIssueFallbackEntry
              ? t(
                  'auto.components.sidebar.useWorktreeCardLinkedDetails.linearIssueUnavailable',
                  'Linear issue details unavailable'
                )
              : t(
                  'auto.components.sidebar.useWorktreeCardLinkedDetails.loadingLinearIssue',
                  'Loading Linear issue...'
                ),
          url: linearIssueUrlFallback
        }
    : null
  const jiraIssueDisplay = getWorktreeCardJiraIssueDisplay(worktree)
  const cardTitleDisplay = getWorktreeCardTitleDisplay({
    storedDisplayName: worktree.displayName,
    displayNameMode: worktree.displayNameMode,
    branchName: branch,
    // Fetched titles only: display fallbacks hold localized loading/unavailable placeholders.
    linearIssueTitle: linearIssue?.title,
    jiraIssueTitle: jiraIssueDisplay?.title,
    issueTitle: issue?.title,
    reviewTitle: prDisplay?.title
  })
  const legacyCardTitleDisplay = coerceWorktreeCardVisibleTitle(worktree.displayName)
  const visibleCardTitle = newCardStyle ? cardTitleDisplay : legacyCardTitleDisplay
  const isDeleting = deleteState?.isDeleting ?? false
  const isQueuedForDeletion = deleteState?.phase === 'queued'
  const deleteLabel = isQueuedForDeletion
    ? t('auto.components.sidebar.WorktreeCard.ef18787206', 'Queued for deletion')
    : t('auto.components.sidebar.WorktreeCard.691ccfd622', 'Deleting…')
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
