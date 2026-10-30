import type { Repo } from '../../../../shared/repo-types'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'
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
import {
  matchWorkspaceReferenceReview,
  matchesWorkspaceReferenceUrl
} from './workspace-reference-details'
import type {
  WorkspaceReferenceDetails,
  WorkspaceReferenceDetailsMap
} from './workspace-reference-details'

type LiveDetails = {
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  review: WorktreeCardPrDisplay | null
}

type CardAttachmentCache = {
  saved: readonly WorkspaceAttachment[]
  savedKeys?: ReadonlySet<string>
  repo?: Repo
  reviewProvider?: WorktreeCardPrDisplay['provider']
  reviewNumber?: number
  reviewTitle?: string
  reviewUrl?: string
  items: readonly WorkspaceAttachment[]
}

// Immutable workspace snapshots bound invalidation; weak ownership releases replaced snapshots.
const cardAttachmentCaches = new WeakMap<Worktree, CardAttachmentCache>()

function getCardAttachmentCache(workspace: Worktree): CardAttachmentCache {
  let cached = cardAttachmentCaches.get(workspace)
  if (!cached) {
    const saved = getWorkspaceAttachments(workspace)
    cached = { saved, items: saved }
    cardAttachmentCaches.set(workspace, cached)
  }
  return cached
}

export function isSavedWorkspaceCardAttachment(
  workspace: Worktree,
  item: WorkspaceAttachment
): boolean {
  const cached = getCardAttachmentCache(workspace)
  cached.savedKeys ??= new Set(cached.saved.map(getWorkspaceAttachmentKey))
  return cached.savedKeys.has(getWorkspaceAttachmentKey(item))
}

function canUseCardReviewSource(item: WorkspaceAttachment, repo: Repo | undefined): boolean {
  return (
    !item.taskSourceContext ||
    (item.provider !== 'linear' &&
      item.provider !== 'jira' &&
      canReadWorkspaceReferenceReview(
        { item, sourceContext: item.taskSourceContext, repo },
        item.provider
      ))
  )
}

export function getWorkspaceCardAttachments(
  workspace: Worktree,
  review: WorktreeCardPrDisplay | null,
  repo?: Repo
): readonly WorkspaceAttachment[] {
  const cached = getCardAttachmentCache(workspace)
  if (!review?.url || review.provider === 'unsupported') {
    return cached.saved
  }
  if (
    cached.repo === repo &&
    cached.reviewProvider === review.provider &&
    cached.reviewNumber === review.number &&
    cached.reviewTitle === review.title &&
    cached.reviewUrl === review.url
  ) {
    return cached.items
  }
  cached.repo = repo
  cached.reviewProvider = review.provider
  cached.reviewNumber = review.number
  cached.reviewTitle = review.title
  cached.reviewUrl = review.url
  cached.items = cached.saved
  if (
    !cached.saved.some(
      (item) => canUseCardReviewSource(item, repo) && matchWorkspaceReferenceReview(item, review)
    )
  ) {
    // Branch discovery supplements saved references without changing persisted links or selection.
    cached.items = [
      ...cached.saved,
      {
        provider: review.provider,
        type: review.provider === 'gitlab' ? 'mr' : 'pr',
        number: review.number,
        title: review.title,
        url: review.url
      }
    ]
  }
  return cached.items
}

export function getWorkspaceCardAttachmentCollection(
  workspace: Worktree | undefined,
  details: LiveDetails,
  repo?: Repo
): { items: readonly WorkspaceAttachment[]; showCollection: boolean } {
  const items = workspace ? getWorkspaceCardAttachments(workspace, details.review, repo) : []
  const showCollection =
    items.length > 1 ||
    Boolean(
      workspace &&
      items.length === 1 &&
      !getWorkspaceHoverAttachments(workspace, details, repo).liveMatched[0]
    )
  return { items, showCollection }
}

export function getWorkspaceHoverAttachments(
  workspace: Worktree,
  details: LiveDetails,
  repo?: Repo
): {
  items: WorkspaceAttachment[]
  activeKey: string | null
  referenceKeys: string[]
  /** Per item: whether it is the card's own review, issue or task, enriched from live details. */
  liveMatched: boolean[]
} {
  const items = getWorkspaceCardAttachments(workspace, details.review, repo)
  const liveMatched: boolean[] = []
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
      canUseCardReviewSource(item, repo) &&
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
      (!item.url || (live.url && matchesWorkspaceReferenceUrl(item, live.url))) &&
      items.filter(
        (candidate) =>
          candidate.provider === item.provider &&
          candidate.type === item.type &&
          matches(candidate) &&
          (!candidate.url || (live.url && matchesWorkspaceReferenceUrl(candidate, live.url)))
      ).length === 1
    liveMatched.push(Boolean(sameReference))
    return sameReference
      ? {
          ...item,
          title: item.title || (item.type === 'issue' || live.url ? live.title : undefined),
          url: item.url || live.url || undefined
        }
      : item
  })
  const legacyActive = getActiveWorkspaceReviewKey(workspace)
  const selected = items.find(
    (item) => getWorkspaceAttachmentKey(item) === legacyActive && canUseCardReviewSource(item, repo)
  )
  const candidates = selected
    ? items.filter(
        (item) =>
          item.provider === selected.provider &&
          item.type === selected.type &&
          item.number === selected.number &&
          canUseCardReviewSource(item, repo)
      )
    : []
  const sourceMatches = candidates.filter(
    (item) => canUseCardReviewSource(item, repo) && item.url && item.url === details.review?.url
  )
  const matchingReviews = items.filter(
    (item) =>
      canUseCardReviewSource(item, repo) && matchWorkspaceReferenceReview(item, details.review)
  )
  const active =
    candidates.length > 1
      ? sourceMatches.length === 1
        ? sourceMatches[0]
        : undefined
      : (selected ?? (matchingReviews.length === 1 ? matchingReviews[0] : undefined))
  const activeIndex = active ? items.indexOf(active) : -1
  const activeItem = enriched[activeIndex]
  return {
    items: enriched,
    referenceKeys: items.map(getWorkspaceAttachmentKey),
    liveMatched,
    activeKey:
      parseWorkspaceKey(workspace.id)?.type === 'folder' || !activeItem
        ? null
        : getWorkspaceAttachmentKey(activeItem)
  }
}

export type WorkspaceLinkedItemRow = {
  item: WorkspaceAttachment
  key: string
  url: string | undefined
  detail: WorkspaceReferenceDetails | undefined
  /** The review whose live state and checks this row shows, when one applies to it. */
  live: WorktreeCardPrDisplay | null
  /** The card's own issue or task this row is, with the state the card already loaded. */
  liveTask: WorktreeCardIssueDisplay | WorktreeCardLinearIssueDisplay | null
}

export function getWorkspaceLinkedItemRows(
  workspace: Worktree,
  details: LiveDetails,
  referenceDetails: WorkspaceReferenceDetailsMap | undefined,
  repo?: Repo
): WorkspaceLinkedItemRow[] {
  const { items, activeKey, referenceKeys, liveMatched } = getWorkspaceHoverAttachments(
    workspace,
    details,
    repo
  )
  const review = details.review
  // Why: references are stored in link order; surfaces list the newest first.
  return items
    .map((item, index) => {
      const key = getWorkspaceAttachmentKey(item)
      const detail = referenceDetails?.[referenceKeys[index]]
      const live =
        detail?.review ??
        (key === activeKey &&
        canUseCardReviewSource(item, repo) &&
        review?.provider === item.provider &&
        review.number === item.number &&
        (!item.url || review.url === item.url)
          ? review
          : null)
      const liveTask = !liveMatched[index]
        ? null
        : item.provider === 'github' && item.type === 'issue'
          ? (details.issue ?? null)
          : item.provider === 'linear'
            ? (details.linearIssue ?? null)
            : null
      return { item, key, url: item.url || detail?.url, detail, live, liveTask }
    })
    .toReversed()
}
