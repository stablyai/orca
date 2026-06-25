import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import type { WorktreeMeta } from '../../../../shared/types'

export type WorktreeMetaSavedPayload = {
  worktreeId: string
  updates: Partial<WorktreeMeta>
}

export function parseExplicitGitHubIssueUrl(input: string): string | null {
  const trimmed = input.trim()
  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link || link.type !== 'issue') {
    return null
  }

  return trimmed
}

/** Pure save-payload builder for the worktree meta dialog: empty inputs clear
 *  the link (null), unparseable inputs leave it untouched (omitted). */
export function buildWorktreeMetaUpdates(args: {
  displayNameInput: string
  currentDisplayName: string
  issueInput: string
  prInput: string
  commentInput: string
}): Partial<WorktreeMeta> {
  const trimmedIssue = args.issueInput.trim()
  const linkedIssueNumber = parseGitHubIssueOrPRNumber(trimmedIssue)
  const finalLinkedIssue =
    trimmedIssue === '' ? null : linkedIssueNumber !== null ? linkedIssueNumber : undefined
  const trimmedPR = args.prInput.trim()
  const linkedPRNumber = parseGitHubIssueOrPRNumber(trimmedPR)
  const finalLinkedPR =
    trimmedPR === '' ? null : linkedPRNumber !== null ? linkedPRNumber : undefined

  const trimmedDisplayName = args.displayNameInput.trim()
  const updates: Partial<WorktreeMeta> = {
    comment: args.commentInput.trim(),
    ...(trimmedDisplayName !== args.currentDisplayName && {
      displayName: trimmedDisplayName || undefined
    })
  }
  if (finalLinkedIssue !== undefined) {
    updates.linkedIssue = finalLinkedIssue
  }
  if (finalLinkedPR !== undefined) {
    updates.linkedPR = finalLinkedPR
  }
  return updates
}
