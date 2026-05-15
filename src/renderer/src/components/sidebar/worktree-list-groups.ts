import { CircleCheckBig, CircleDot, CircleX, Folder, GitPullRequest, Pin } from 'lucide-react'
import type React from 'react'
import type { Repo, Worktree, WorkspaceStatusDefinition } from '../../../../shared/types'
import { branchName } from '@/lib/git-utils'
import {
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  getWorkspaceStatusVisualMeta
} from './workspace-status'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { SortBy } from './smart-sort'

export { branchName }

export type WorktreeGroupBy = 'none' | 'repo' | 'pr-status'
export type RepoGroupOrdering = 'manual' | 'visible-worktree-order'

export function getRepoGroupOrdering(groupBy: WorktreeGroupBy, sortBy: SortBy): RepoGroupOrdering {
  return groupBy === 'repo' && (sortBy === 'recent' || sortBy === 'smart')
    ? 'visible-worktree-order'
    : 'manual'
}

export type GroupHeaderRow = {
  type: 'header'
  key: string
  label: string
  count: number
  tone: string
  icon?: React.ComponentType<{ className?: string }>
  repo?: Repo
}

export type WorktreeRow = { type: 'item'; worktree: Worktree; repo: Repo | undefined }
export type Row = GroupHeaderRow | WorktreeRow

export type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

export const PR_GROUP_ORDER: PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

export const PR_GROUP_META: Record<
  PRGroupKey,
  {
    label: string
    icon: React.ComponentType<{ className?: string }>
    tone: string
  }
> = {
  done: {
    label: 'Done',
    icon: CircleCheckBig,
    tone: 'text-emerald-700 dark:text-emerald-200'
  },
  'in-review': {
    label: 'In review',
    icon: GitPullRequest,
    tone: 'text-sky-700 dark:text-sky-200'
  },
  'in-progress': {
    label: 'In progress',
    icon: CircleDot,
    tone: 'text-amber-700 dark:text-amber-200'
  },
  closed: {
    label: 'Closed',
    icon: CircleX,
    tone: 'text-zinc-600 dark:text-zinc-300'
  }
}

export const REPO_GROUP_META = {
  tone: 'text-foreground',
  icon: Folder
} as const

export const PINNED_GROUP_KEY = 'pinned'

export const PINNED_GROUP_META = {
  label: 'Pinned',
  tone: 'text-foreground',
  icon: Pin
} as const

export function getPRGroupKey(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null
): PRGroupKey {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  const cacheKey = repo && branch ? `${repo.path}::${branch}` : ''
  const prEntry =
    cacheKey && prCache
      ? (prCache[cacheKey] as { data?: { state?: string } } | undefined)
      : undefined
  const pr = prEntry?.data

  if (!pr) {
    return 'in-progress'
  }
  if (pr.state === 'merged') {
    return 'done'
  }
  if (pr.state === 'closed') {
    return 'closed'
  }
  if (pr.state === 'draft') {
    return 'in-progress'
  }
  return 'in-review'
}

/**
 * Emit a "Pinned" header + its items into `result`, returning the set of
 * pinned worktree IDs so the caller can exclude them from regular groups.
 */
function emitPinnedGroup(
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  collapsedGroups: Set<string>,
  result: Row[],
  force = false
): Set<string> {
  const pinned = worktrees.filter((w) => w.isPinned)
  if (pinned.length === 0 && !force) {
    return new Set()
  }

  result.push({
    type: 'header',
    key: PINNED_GROUP_KEY,
    label: PINNED_GROUP_META.label,
    count: pinned.length,
    tone: PINNED_GROUP_META.tone,
    icon: PINNED_GROUP_META.icon
  })
  if (!collapsedGroups.has(PINNED_GROUP_KEY)) {
    for (const w of pinned) {
      result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) })
    }
  }
  return new Set(pinned.map((w) => w.id))
}

/**
 * Build the flat row list consumed by the virtualizer.
 * Extracted here to keep WorktreeList.tsx under the line-count lint limit.
 */
export function buildRows(
  groupBy: WorktreeGroupBy,
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  collapsedGroups: Set<string>,
  repoOrder?: Map<string, number>,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  repoGroupOrdering: RepoGroupOrdering = 'manual'
): Row[] {
  const result: Row[] = []

  const pinnedIds = emitPinnedGroup(worktrees, repoMap, collapsedGroups, result, groupBy === 'none')
  const unpinned = pinnedIds.size > 0 ? worktrees.filter((w) => !pinnedIds.has(w.id)) : worktrees

  const grouped = new Map<string, { label: string; items: Worktree[]; repo?: Repo }>()
  for (const w of unpinned) {
    let key: string
    let label: string
    let repo: Repo | undefined
    if (groupBy === 'repo') {
      repo = repoMap.get(w.repoId)
      key = `repo:${w.repoId}`
      label = repo?.displayName ?? 'Unknown'
    } else if (groupBy === 'none') {
      const workspaceStatus = getWorkspaceStatus(w, workspaceStatuses)
      key = getWorkspaceStatusGroupKey(workspaceStatus)
      label =
        workspaceStatuses.find((status) => status.id === workspaceStatus)?.label ?? workspaceStatus
    } else {
      const prGroup = getPRGroupKey(w, repoMap, prCache)
      key = `pr:${prGroup}`
      label = PR_GROUP_META[prGroup].label
    }
    if (!grouped.has(key)) {
      grouped.set(key, { label, items: [], repo })
    }
    grouped.get(key)!.items.push(w)
  }

  const orderedGroups: [string, { label: string; items: Worktree[]; repo?: Repo }][] = []
  if (groupBy === 'pr-status') {
    for (const prGroup of PR_GROUP_ORDER) {
      const key = `pr:${prGroup}`
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else if (groupBy === 'none') {
    // Why: the old "All" grouping now organizes workspaces by user status.
    // Keep the sidebar compact by rendering only sections that contain cards;
    // the board drawer is the wider all-lanes drag target.
    for (const status of workspaceStatuses) {
      const key = getWorkspaceStatusGroupKey(status.id)
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else {
    // Why: dynamic sorts need repo headers to follow their highest-ranked
    // visible child. Manual ordering still uses the canonical state.repos
    // order so repo-header drag has a stable source of truth.
    const entries = Array.from(grouped.entries())
    if (repoGroupOrdering === 'manual' && repoOrder) {
      const rankFor = (key: string): number => {
        const repoId = key.startsWith('repo:') ? key.slice('repo:'.length) : key
        const rank = repoOrder.get(repoId)
        return rank === undefined ? Number.POSITIVE_INFINITY : rank
      }
      entries.sort((a, b) => {
        const ra = rankFor(a[0])
        const rb = rankFor(b[0])
        if (ra !== rb) {
          return ra - rb
        }
        return a[1].label.localeCompare(b[1].label)
      })
    }
    orderedGroups.push(...entries)
  }

  for (const [key, group] of orderedGroups) {
    const isCollapsed = collapsedGroups.has(key)
    const repo = group.repo
    const header =
      groupBy === 'repo'
        ? {
            type: 'header' as const,
            key,
            label: group.label,
            count: group.items.length,
            tone: REPO_GROUP_META.tone,
            icon: REPO_GROUP_META.icon,
            repo
          }
        : groupBy === 'none'
          ? (() => {
              const workspaceStatus =
                getWorkspaceStatusFromGroupKey(key, workspaceStatuses) ??
                workspaceStatuses[0]?.id ??
                'in-progress'
              const definition = workspaceStatuses.find((status) => status.id === workspaceStatus)
              const meta = getWorkspaceStatusVisualMeta(definition ?? workspaceStatus)
              return {
                type: 'header' as const,
                key,
                label: definition?.label ?? workspaceStatus,
                count: group.items.length,
                tone: meta.tone,
                icon: meta.icon
              }
            })()
          : (() => {
              const prGroup = key.replace(/^pr:/, '') as PRGroupKey
              const meta = PR_GROUP_META[prGroup]
              return {
                type: 'header' as const,
                key,
                label: meta.label,
                count: group.items.length,
                tone: meta.tone,
                icon: meta.icon
              }
            })()

    result.push(header)
    if (!isCollapsed) {
      for (const w of group.items) {
        result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) })
      }
    }
  }

  return result
}

export function getGroupKeyForWorktree(
  groupBy: WorktreeGroupBy,
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses()
): string | null {
  if (groupBy === 'none') {
    return getWorkspaceStatusGroupKey(getWorkspaceStatus(worktree, workspaceStatuses))
  }
  if (groupBy === 'repo') {
    return `repo:${worktree.repoId}`
  }
  return `pr:${getPRGroupKey(worktree, repoMap, prCache)}`
}
