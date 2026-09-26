import React from 'react'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import type { WorktreeCardController } from './use-worktree-card-controller'
import type { WorktreeHoverFacts, WorktreeHoverLinks } from './worktree-hover-facts'

const WorktreeHoverFactsContext = React.createContext<WorktreeHoverFacts | null>(null)

/** Reads the workspace facts published by the surrounding card, if any. */
export function useWorktreeHoverFacts(): WorktreeHoverFacts | null {
  return React.useContext(WorktreeHoverFactsContext)
}

/** The card's own open-in-Orca handlers, falling back to the browser for other providers. */
function buildWorktreeHoverLinks(card: WorktreeCardController): WorktreeHoverLinks {
  const reviewUrl = card.hoverReview?.url
  const issueUrl = card.hoverIssue && 'url' in card.hoverIssue ? card.hoverIssue.url : undefined
  const linearUrl = card.hoverLinearIssue?.url
  const jiraUrl = card.hoverJiraIssue?.url

  return {
    openReview:
      reviewUrl && card.hoverReview?.provider === 'github'
        ? card.handleOpenReviewInOrca
        : reviewUrl
          ? (event) => {
              event.stopPropagation()
              card.handleOpenReviewInBrowser(reviewUrl)
            }
          : undefined,
    openIssue: issueUrl
      ? card.hoverIssue && 'labels' in card.hoverIssue
        ? card.handleOpenGitHubIssueInOrca
        : (event) => {
            event.stopPropagation()
            card.handleOpenIssueInBrowser(issueUrl)
          }
      : undefined,
    openLinearIssue: card.linearIssue
      ? card.handleOpenLinearIssueInOrca
      : linearUrl
        ? (event) => {
            event.stopPropagation()
            card.handleOpenIssueInBrowser(linearUrl)
          }
        : undefined,
    openJiraIssue: jiraUrl
      ? (event) => {
          event.stopPropagation()
          card.handleOpenIssueInBrowser(jiraUrl)
        }
      : undefined
  }
}

/** Collects what the card already resolved — no store reads, no cache lookups. */
export function buildWorktreeHoverFacts(card: WorktreeCardController): WorktreeHoverFacts {
  const title = card.visibleCardTitle.trim() || card.worktree.displayName
  const identity = card.isFolder ? card.worktree.path : card.branch
  const note = card.hoverComment?.trim()

  return {
    title,
    worktreeId: card.worktree.id,
    workspaceStatusId: card.worktree.workspaceStatus,
    isUnread: card.worktree.isUnread,
    identity: identity && identity !== title ? identity : undefined,
    identityKind: card.isFolder ? 'path' : 'branch',
    repoName: card.repo?.displayName,
    repoIcon: card.repo?.repoIcon ?? null,
    // Why: local execution needs no chip; only a remote host changes how the row reads.
    hostLabel: card.sshTargetLabel ?? card.runtimeHostLabel ?? undefined,
    review: card.hoverReview,
    issue: card.hoverIssue,
    linearIssue: card.hoverLinearIssue,
    linearStateColor: card.linearIssue?.state?.color,
    jiraIssue: card.hoverJiraIssue,
    portCount: card.workspacePorts.length,
    portLabels: card.workspacePorts.map((port) => String(port.port)),
    childWorkspaceCount: card.lineageChildCount ?? 0,
    conflictOperation:
      card.conflictOperation && card.conflictOperation !== 'unknown'
        ? card.conflictOperation
        : undefined,
    note: note || undefined,
    isPinned: card.worktree.isPinned,
    activityAgo:
      card.worktree.lastActivityAt > 0
        ? formatShortTimeAgo(card.worktree.lastActivityAt, Date.now())
        : undefined,
    links: buildWorktreeHoverLinks(card)
  }
}

export function WorktreeHoverFactsProvider({
  facts,
  children
}: {
  facts: WorktreeHoverFacts
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <WorktreeHoverFactsContext.Provider value={facts}>
      {children}
    </WorktreeHoverFactsContext.Provider>
  )
}
