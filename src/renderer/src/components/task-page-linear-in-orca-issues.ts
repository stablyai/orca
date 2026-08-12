import type { LinearIssue, LinearWorkspace, Worktree } from '../../../shared/types'
import { parseLinearIssueInput } from '../../../shared/linear-links'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { normalizeLinearIdentifier } from '../lib/linear-issue-workspace-attachment'

export type LinkedLinearIssueRef = {
  identifier: string
  workspaceId: string | null
  organizationUrlKey?: string
  sourceContext?: TaskSourceContext | null
}

type LinkedLinearWorktreeFields = Pick<Worktree, 'linkedLinearIssue'> &
  Partial<
    Pick<
      Worktree,
      | 'isArchived'
      | 'linkedLinearIssueWorkspaceId'
      | 'linkedLinearIssueOrganizationUrlKey'
      | 'linkedTaskSourceContext'
    >
  >

// Why: Has Workspace is an Orca workspace view, not a Linear API filter.
export function collectLinkedLinearIssueRefsFromWorktrees(
  worktrees: readonly LinkedLinearWorktreeFields[],
  options?: {
    workspaceId?: string | null
    workspaces?: readonly Pick<LinearWorkspace, 'id' | 'organizationUrlKey'>[]
  }
): LinkedLinearIssueRef[] {
  const selectedWorkspaceId =
    options?.workspaceId && options.workspaceId !== 'all' ? options.workspaceId : null
  const workspaceIdByOrgKey = new Map<string, string>()
  for (const workspace of options?.workspaces ?? []) {
    if (workspace.organizationUrlKey) {
      workspaceIdByOrgKey.set(workspace.organizationUrlKey.toLowerCase(), workspace.id)
    }
  }
  const byIdentifier = new Map<string, LinkedLinearIssueRef[]>()

  for (const worktree of worktrees) {
    if (worktree.isArchived) {
      continue
    }
    // Why: links can be stored as a URL or in any casing; the Linear read needs the bare identifier.
    const identifier = normalizeLinearIdentifier(worktree.linkedLinearIssue)
    if (!identifier) {
      continue
    }
    const organizationUrlKey =
      worktree.linkedLinearIssueOrganizationUrlKey?.trim() ||
      parseLinearIssueInput(worktree.linkedLinearIssue ?? '')?.organizationUrlKey
    const sourceContext = worktree.linkedTaskSourceContext
    const sourceWorkspaceId =
      sourceContext?.providerIdentity?.provider === 'linear'
        ? sourceContext.providerIdentity.workspaceId
        : null
    const workspaceId =
      worktree.linkedLinearIssueWorkspaceId?.trim() ||
      sourceWorkspaceId?.trim() ||
      (organizationUrlKey
        ? (workspaceIdByOrgKey.get(organizationUrlKey.toLowerCase()) ?? null)
        : null)
    if (selectedWorkspaceId && workspaceId && workspaceId !== selectedWorkspaceId) {
      continue
    }
    const ref: LinkedLinearIssueRef = {
      identifier,
      workspaceId,
      ...(organizationUrlKey ? { organizationUrlKey } : {}),
      ...(sourceContext !== undefined ? { sourceContext } : {})
    }
    const sourceScope = sourceContext ? getTaskSourceCacheScope(sourceContext) : ''
    const refScope = `${workspaceId ?? ''}::${organizationUrlKey?.toLowerCase() ?? ''}::${sourceScope}`
    const existing = byIdentifier.get(identifier)
    if (!existing) {
      byIdentifier.set(identifier, [ref])
      continue
    }
    if (
      existing.some((candidate) => {
        const candidateSourceScope = candidate.sourceContext
          ? getTaskSourceCacheScope(candidate.sourceContext)
          : ''
        return (
          `${candidate.workspaceId ?? ''}::${candidate.organizationUrlKey?.toLowerCase() ?? ''}::${candidateSourceScope}` ===
          refScope
        )
      })
    ) {
      continue
    }
    const unscopedIndex = existing.findIndex(
      (candidate) =>
        !candidate.workspaceId &&
        !candidate.organizationUrlKey &&
        (candidate.sourceContext ? getTaskSourceCacheScope(candidate.sourceContext) : '') ===
          sourceScope
    )
    if ((workspaceId || organizationUrlKey) && unscopedIndex !== -1) {
      existing[unscopedIndex] = ref
    } else if (!workspaceId && !organizationUrlKey) {
      const hasSameSourceScope = existing.some(
        (candidate) =>
          (candidate.sourceContext ? getTaskSourceCacheScope(candidate.sourceContext) : '') ===
          sourceScope
      )
      if (!hasSameSourceScope) {
        existing.push(ref)
      }
    } else {
      existing.push(ref)
    }
  }

  return [...byIdentifier.values()].flat()
}

export function filterLinearIssuesForInOrcaWorkspace(
  issues: readonly LinearIssue[],
  workspaceId: string | null | undefined
): LinearIssue[] {
  if (!workspaceId || workspaceId === 'all') {
    return [...issues]
  }
  return issues.filter((issue) => !issue.workspaceId || issue.workspaceId === workspaceId)
}

export function filterLinearIssuesBySearchQuery(
  issues: readonly LinearIssue[],
  query: string
): LinearIssue[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return [...issues]
  }
  return issues.filter((issue) => {
    return (
      issue.identifier.toLowerCase().includes(trimmed) ||
      issue.title.toLowerCase().includes(trimmed) ||
      issue.team.name.toLowerCase().includes(trimmed) ||
      (issue.assignee?.displayName.toLowerCase().includes(trimmed) ?? false)
    )
  })
}

export function linkedLinearIssueRefsSignature(refs: readonly LinkedLinearIssueRef[]): string {
  return refs
    .map((ref) => {
      const sourceScope = ref.sourceContext ? getTaskSourceCacheScope(ref.sourceContext) : ''
      return `${ref.identifier.toUpperCase()}::${ref.workspaceId ?? ''}::${ref.organizationUrlKey?.toLowerCase() ?? ''}::${sourceScope}`
    })
    .sort()
    .join('|')
}

export async function readLinkedLinearIssuesWithLimit(
  refs: readonly LinkedLinearIssueRef[],
  read: (ref: LinkedLinearIssueRef) => Promise<LinearIssue | null>,
  concurrency = 6
): Promise<(LinearIssue | null)[]> {
  const results = Array.from({ length: refs.length }, (): LinearIssue | null => null)
  let nextIndex = 0
  const workerCount = Math.min(refs.length, Math.max(1, Math.floor(concurrency)))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < refs.length) {
        const index = nextIndex++
        results[index] = await read(refs[index])
      }
    })
  )
  return results
}
