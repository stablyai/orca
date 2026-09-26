import type React from 'react'
import type { RepoIcon } from '../../../../shared/repo-icon'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardJiraIssueDisplay,
  WorktreeCardLinearIssueDisplay
} from './worktree-card-meta-types'

/** Deep links for the chips, so a card is a way in and not just a read. */
export type WorktreeHoverLinks = {
  openReview?: (event: React.MouseEvent) => void
  openIssue?: (event: React.MouseEvent) => void
  openLinearIssue?: (event: React.MouseEvent) => void
  openJiraIssue?: (event: React.MouseEvent) => void
}

/**
 * Everything a hover card says about the workspace behind a row. Built from the
 * card controller, which already resolved the caches and host scoping, so nothing
 * here re-queries the store.
 */
export type WorktreeHoverFacts = {
  title: string
  /** Lets the card mount the chips that need live state; absent outside a card. */
  worktreeId?: string
  workspaceStatusId?: string
  isUnread?: boolean
  /** Branch for a git worktree, path for a folder workspace. */
  identity?: string
  identityKind: 'branch' | 'path'
  repoName?: string
  repoIcon?: RepoIcon | null
  hostLabel?: string
  review?: WorktreeCardPrDisplay | null
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  linearStateColor?: string
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  portCount: number
  portLabels: string[]
  childWorkspaceCount: number
  conflictOperation?: string
  note?: string
  isPinned?: boolean
  /** Relative time since the workspace last saw activity. */
  activityAgo?: string
  links?: WorktreeHoverLinks
}

/** Title of the linked work item, when it says something the card doesn't already. */
export function getWorktreeHoverContextTitle(
  facts: WorktreeHoverFacts,
  ...alreadyShown: (string | undefined)[]
): string | null {
  const taken = new Set(
    [facts.title, ...alreadyShown].map((value) => value?.trim()).filter(Boolean)
  )
  const candidates = [
    facts.review?.title,
    facts.linearIssue?.title,
    facts.issue?.title,
    facts.jiraIssue?.title
  ]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed && !taken.has(trimmed)) {
      return trimmed
    }
  }
  return null
}
