import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getLinearOrganizationUrlKeyFromIssueUrl,
  parseLinearIssueInput
} from '../../../shared/linear/links'
import { getWorktreeAttachmentLabel } from './worktree-attachment-label'

export type LinearIssueAttachmentRef = Pick<LinearIssue, 'identifier'> &
  Partial<Pick<LinearIssue, 'workspaceId' | 'url'>>

/** Normalized identifier -> linking worktrees, in worktree order. */
export type LinearIssueWorkspaceAttachmentIndex = ReadonlyMap<string, readonly Worktree[]>

export function normalizeLinearIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  const parsed = parseLinearIssueInput(trimmed)
  return (parsed?.identifier ?? trimmed).toUpperCase()
}

function scopeMatchScore(args: {
  issueWorkspaceId?: string | null
  worktreeWorkspaceId?: string | null
  issueOrganizationUrlKey?: string | null
  worktreeOrganizationUrlKey?: string | null
}): number | null {
  const issueWorkspaceId = args.issueWorkspaceId?.trim() || null
  const worktreeWorkspaceId = args.worktreeWorkspaceId?.trim() || null
  // Why: when both sides declare a workspace, refuse cross-workspace identifier collisions.
  if (issueWorkspaceId && worktreeWorkspaceId && issueWorkspaceId !== worktreeWorkspaceId) {
    return null
  }

  const issueOrgKey = args.issueOrganizationUrlKey?.trim().toLowerCase() || null
  const worktreeOrgKey = args.worktreeOrganizationUrlKey?.trim().toLowerCase() || null
  if (issueOrgKey && worktreeOrgKey && issueOrgKey !== worktreeOrgKey) {
    return null
  }

  return (
    Number(Boolean(issueWorkspaceId && worktreeWorkspaceId)) +
    Number(Boolean(issueOrgKey && worktreeOrgKey))
  )
}

function findScopedAttachment(
  candidates: readonly Worktree[],
  issue: LinearIssueAttachmentRef
): Worktree | null {
  const issueOrganizationUrlKey = getLinearOrganizationUrlKeyFromIssueUrl(issue.url)
  let best: Worktree | null = null
  let bestScore = -1
  for (const worktree of candidates) {
    const score = scopeMatchScore({
      issueWorkspaceId: issue.workspaceId,
      worktreeWorkspaceId: worktree.linkedLinearIssueWorkspaceId,
      issueOrganizationUrlKey,
      worktreeOrganizationUrlKey: worktree.linkedLinearIssueOrganizationUrlKey
    })
    if (
      score != null &&
      (score > bestScore ||
        (score === bestScore && best && worktree.lastActivityAt > best.lastActivityAt))
    ) {
      best = worktree
      bestScore = score
    }
  }
  return best
}

export function findLinearIssueWorkspaceAttachment(
  worktrees: readonly Worktree[],
  issue: LinearIssueAttachmentRef
): Worktree | null {
  const identifier = normalizeLinearIdentifier(issue.identifier)
  if (!identifier) {
    return null
  }

  return findScopedAttachment(
    worktrees.filter(
      (worktree) =>
        !worktree.isArchived && normalizeLinearIdentifier(worktree.linkedLinearIssue) === identifier
    ),
    issue
  )
}

/** Why: issue rows would otherwise rescan (and re-parse) every worktree per row; one
 *  pass per worktree list turns each row lookup into a map hit. */
export function buildLinearIssueWorkspaceAttachmentIndex(
  worktrees: readonly Worktree[]
): LinearIssueWorkspaceAttachmentIndex {
  const index = new Map<string, Worktree[]>()
  for (const worktree of worktrees) {
    if (worktree.isArchived) {
      continue
    }
    const identifier = normalizeLinearIdentifier(worktree.linkedLinearIssue)
    if (!identifier) {
      continue
    }
    const bucket = index.get(identifier)
    if (bucket) {
      bucket.push(worktree)
    } else {
      index.set(identifier, [worktree])
    }
  }
  return index
}

export function findLinearIssueWorkspaceAttachmentInIndex(
  index: LinearIssueWorkspaceAttachmentIndex,
  issue: LinearIssueAttachmentRef
): Worktree | null {
  const identifier = normalizeLinearIdentifier(issue.identifier)
  if (!identifier) {
    return null
  }
  const candidates = index.get(identifier)
  return candidates ? findScopedAttachment(candidates, issue) : null
}

export function getLinearIssueWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getWorktreeAttachmentLabel(worktree)
}
