import type { Worktree } from '../../../../shared/types'

/** The linked Linear issue a panel should render, resolved from a worktree. */
export type LinearPanelTarget = {
  /** Human identifier (e.g. `ENG-123`); the Linear SDK resolves it like a uuid. */
  identifier: string
  /** Concrete Linear workspace, or 'all' when the worktree never recorded one. */
  workspaceId: string
  organizationUrlKey: string | null
}

/**
 * Why 'all': worktrees linked before multi-workspace support (and those created
 * from a search across workspaces) carry no workspace id, and a narrowed lookup
 * would miss the issue entirely. Matches how WorktreeCard resolves the link.
 */
export function getLinearPanelTarget(
  worktree: Worktree | null | undefined
): LinearPanelTarget | null {
  const identifier = worktree?.linkedLinearIssue
  if (!identifier) {
    return null
  }
  return {
    identifier,
    workspaceId: worktree?.linkedLinearIssueWorkspaceId || 'all',
    organizationUrlKey: worktree?.linkedLinearIssueOrganizationUrlKey ?? null
  }
}

/**
 * Offline URL builder: the fetched issue carries its own url, but the panel has
 * to offer "open in Linear" before hydration and while the fetch is failing.
 */
export function getLinearIssueBrowserUrl(
  target: LinearPanelTarget,
  fetchedUrl?: string | null
): string | null {
  if (fetchedUrl) {
    return fetchedUrl
  }
  return target.organizationUrlKey
    ? `https://linear.app/${encodeURIComponent(target.organizationUrlKey)}/issue/${encodeURIComponent(target.identifier)}`
    : null
}
