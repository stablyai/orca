import { readLinkedTaskIssuesWithLimit } from '../../read-linked-task-issues'
import type {
  LinearIssueRead,
  LinearIssueLease,
  LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearWorkspace } from '../../../../../shared/linear/workspace-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { parseLinearIssueInput } from '../../../../../shared/linear/links'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import { normalizeLinearIdentifier } from '../../../lib/linear-issue-workspace-attachment'

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

export function readLinkedLinearIssuesWithLimit(
  refs: readonly LinkedLinearIssueRef[],
  read: (ref: LinkedLinearIssueRef) => LinearIssueRead<LinearIssue | null>,
  concurrency = 6
): LinearIssueRead<(LinearIssue | null)[]> {
  return {
    acquire: (isLive = () => true) => {
      let live = true
      let initializing = true
      const children = new Map<
        LinkedLinearIssueRef,
        {
          lease: LinearIssueLease<LinearIssue | null>
          view: LinearIssueView<LinearIssue | null>
          release: () => void
        }
      >()
      const listeners = new Set<() => void>()
      let view: LinearIssueView<(LinearIssue | null)[]> = { kind: 'loading', data: null }
      const notify = () => {
        // oxlint-disable-next-line unicorn/no-useless-spread -- Why: subscribers may change the listener set synchronously.
        for (const listener of [...listeners]) {
          listener()
        }
      }
      const update = () => {
        if (!live || initializing) {
          return
        }
        const ordered = refs.map((ref) => children.get(ref))
        if (ordered.some((child) => child?.view.kind === 'abandoned')) {
          view = { kind: 'abandoned', data: null }
          notify()
          return
        }
        const loading = ordered.some((child) => child?.view.kind === 'loading')
        const data = ordered.map((child) =>
          child?.view.kind === 'data' || child?.view.kind === 'loading' ? child.view.data : null
        )
        view = loading ? { kind: 'loading', data } : { kind: 'data', data }
        notify()
      }
      void readLinkedTaskIssuesWithLimit(
        refs,
        async (ref) => {
          if (!live || !isLive() || view.kind === 'abandoned') {
            return null
          }
          const lease = read(ref).acquire(() => live && isLive())
          const child = { lease, view: lease.currentView(), release: () => {} }
          children.set(ref, child)
          child.release = lease.subscribe(() => {
            child.view = lease.currentView()
            update()
          })
          await lease.waitForCurrentTerminal()
          return null
        },
        concurrency
      ).then(() => {
        initializing = false
        update()
      })
      return {
        currentView: () => (live && isLive() ? view : { kind: 'abandoned', data: null }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        commit: (expected, previous, reduce) => {
          if (
            !live ||
            !isLive() ||
            expected !== view ||
            [...children.values()].some(
              (child) => !child.lease.commit(child.view, false, () => true)
            )
          ) {
            return previous
          }
          return reduce(previous, expected.data)
        },
        waitForCurrentTerminal: () =>
          new Promise((resolve) => {
            const finish = () => {
              if (!live || view.kind !== 'loading') {
                listeners.delete(finish)
                resolve(live ? view : { kind: 'abandoned', data: null })
              }
            }
            listeners.add(finish)
            finish()
          }),
        release: () => {
          live = false
          notify()
          listeners.clear()
          for (const child of children.values()) {
            child.release()
            child.lease.release()
          }
        }
      }
    }
  }
}
