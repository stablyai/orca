import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getActiveWorkspaceReviewKey } from './worktree-attachment-editing'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardJiraIssueDisplay
} from './worktree-card-meta-types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

type LiveDetails = {
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  review: WorktreeCardPrDisplay | null
}

export function getWorkspaceHoverAttachments(
  workspace: Worktree,
  details: LiveDetails
): {
  items: WorkspaceAttachment[]
  activeKey: string | null
  referenceKeys: string[]
} {
  const items = getWorkspaceAttachments(workspace)
  const matches = (item: WorkspaceAttachment): boolean => {
    if (item.provider === 'github' && item.type === 'issue') {
      return item.number === details.issue?.number
    }
    if (item.provider === 'linear') {
      return (item.identifier ?? item.linearIdentifier) === details.linearIssue?.identifier
    }
    if (item.provider === 'jira') {
      return (item.identifier ?? item.jiraIdentifier) === details.jiraIssue?.identifier
    }
    return (
      item.type !== 'issue' &&
      item.provider === details.review?.provider &&
      item.number === details.review?.number
    )
  }
  const enriched = items.map((item) => {
    const live =
      item.provider === 'github' && item.type === 'issue'
        ? details.issue
        : item.provider === 'linear'
          ? details.linearIssue
          : item.provider === 'jira'
            ? details.jiraIssue
            : details.review
    const sameReference =
      matches(item) &&
      live &&
      (!item.url || item.url === live.url) &&
      items.filter(
        (candidate) =>
          candidate.provider === item.provider &&
          candidate.type === item.type &&
          matches(candidate) &&
          (!candidate.url || candidate.url === live.url)
      ).length === 1
    return sameReference
      ? {
          ...item,
          title: item.title || (item.type === 'issue' || live.url ? live.title : undefined),
          url: item.url || live.url || undefined
        }
      : item
  })
  const legacyActive = getActiveWorkspaceReviewKey(workspace)
  const selected = items.find((item) => getWorkspaceAttachmentKey(item) === legacyActive)
  const candidates = selected
    ? items.filter(
        (item) =>
          item.provider === selected.provider &&
          item.type === selected.type &&
          item.number === selected.number
      )
    : []
  const sourceMatches = candidates.filter((item) => item.url && item.url === details.review?.url)
  const active =
    candidates.length > 1 ? (sourceMatches.length === 1 ? sourceMatches[0] : undefined) : selected
  const activeIndex = active ? items.indexOf(active) : -1
  const activeItem = enriched[activeIndex]
  return {
    items: enriched,
    referenceKeys: items.map(getWorkspaceAttachmentKey),
    activeKey:
      parseWorkspaceKey(workspace.id)?.type === 'folder' || !activeItem
        ? null
        : getWorkspaceAttachmentKey(activeItem)
  }
}
