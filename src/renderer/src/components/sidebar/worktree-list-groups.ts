import {
  CircleCheckBig,
  CircleDot,
  CircleX,
  Folder,
  GitPullRequest,
  LayoutList,
  Pin
} from 'lucide-react'
import type React from 'react'
import type { Repo, Worktree } from '../../../../shared/types'
import { branchName } from '@/lib/git-utils'

export { branchName }

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

export const ALL_GROUP_KEY = 'all'

export const ALL_GROUP_META = {
  label: 'All',
  tone: 'text-foreground',
  icon: LayoutList
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
  result: Row[]
): Set<string> {
  const pinned = worktrees.filter((w) => w.isPinned)
  if (pinned.length === 0) {
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
  groupBy: 'none' | 'repo' | 'pr-status',
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  collapsedGroups: Set<string>,
  repoOrder?: Map<string, number>
): Row[] {
  const result: Row[] = []

  const pinnedIds = emitPinnedGroup(worktrees, repoMap, collapsedGroups, result)
  const unpinned = pinnedIds.size > 0 ? worktrees.filter((w) => !pinnedIds.has(w.id)) : worktrees

  if (groupBy === 'none') {
    // Without an "All" header, the unpinned block is visually indistinguishable
    // from a continuation of the Pinned section — so when pinned items exist,
    // mark the boundary with a sibling header that mirrors the Pinned one.
    if (pinnedIds.size > 0 && unpinned.length > 0) {
      result.push({
        type: 'header',
        key: ALL_GROUP_KEY,
        label: ALL_GROUP_META.label,
        count: unpinned.length,
        tone: ALL_GROUP_META.tone,
        icon: ALL_GROUP_META.icon
      })
      if (collapsedGroups.has(ALL_GROUP_KEY)) {
        return result
      }
    }
    for (const w of unpinned) {
      result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) })
    }
    return result
  }

  const grouped = new Map<string, { label: string; items: Worktree[]; repo?: Repo }>()
  for (const w of unpinned) {
    let key: string
    let label: string
    let repo: Repo | undefined
    if (groupBy === 'repo') {
      repo = repoMap.get(w.repoId)
      key = `repo:${w.repoId}`
      label = repo?.displayName ?? 'Unknown'
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
  } else {
    // Why: header order must follow the canonical state.repos array order, not
    // first-encounter from the smart-sorted worktree stream — otherwise sorting
    // or filtering side effects could shuffle which repo header appears first,
    // and manual reorder would have nothing to bind to. Unknown ids (no entry
    // in repoOrder) sort last by label so they remain deterministic.
    const entries = Array.from(grouped.entries())
    if (repoOrder) {
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
  groupBy: 'none' | 'repo' | 'pr-status',
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null
): string | null {
  if (groupBy === 'none') {
    return null
  }
  if (groupBy === 'repo') {
    return `repo:${worktree.repoId}`
  }
  return `pr:${getPRGroupKey(worktree, repoMap, prCache)}`
}
