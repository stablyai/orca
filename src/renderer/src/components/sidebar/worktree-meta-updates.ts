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

export function parseGitHubWorkItemNumberForMetaField(
  input: string,
  expectedType: 'issue' | 'pr'
): number | null {
  const link = parseGitHubIssueOrPRLink(input)
  if (link) {
    // Why: issue and PR numbers live in separate GitHub namespaces for refs;
    // a URL path mismatch must not silently link the other field.
    return link.type === expectedType ? link.number : null
  }

  return parseGitHubIssueOrPRNumber(input)
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
  const linkedIssueNumber = parseGitHubWorkItemNumberForMetaField(trimmedIssue, 'issue')
  const finalLinkedIssue =
    trimmedIssue === '' ? null : linkedIssueNumber !== null ? linkedIssueNumber : undefined
  const trimmedPR = args.prInput.trim()
  const linkedPRNumber = parseGitHubWorkItemNumberForMetaField(trimmedPR, 'pr')
  const finalLinkedPR =
    trimmedPR === '' ? null : linkedPRNumber !== null ? linkedPRNumber : undefined

  // Why: blanking the field means "fall back to the branch/folder name", and the
  // empty string is how that intent is persisted. Emitting `undefined` instead
  // put a present-but-undefined key into the store spread, wiping the live name
  // and crashing the worktree palette (crash a1f81ea1).
  const trimmedDisplayName = args.displayNameInput.trim()
  const updates: Partial<WorktreeMeta> = {
    comment: args.commentInput.trim(),
    ...(trimmedDisplayName !== args.currentDisplayName && { displayName: trimmedDisplayName })
  }
  if (finalLinkedIssue !== undefined) {
    updates.linkedIssue = finalLinkedIssue
  }
  if (finalLinkedPR !== undefined) {
    updates.linkedPR = finalLinkedPR
  }
  return updates
}
