import { CircleCheckBig, CircleDot, CircleX, FolderGit2, GitPullRequest } from 'lucide-react'
import type React from 'react'
import type { Repo, Worktree } from '../../../../shared/types'

export function branchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export type GroupHeaderRow = {
  type: 'header'
  key: string
  label: string
  count: number
  tone: string
  icon: React.ComponentType<{ className?: string }>
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
  icon: FolderGit2
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
 * Build the flat row list consumed by the virtualizer.
 * Extracted here to keep WorktreeList.tsx under the line-count lint limit.
 */
export function buildRows(
  groupBy: 'none' | 'repo' | 'pr-status',
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  collapsedGroups: Set<string>
): Row[] {
  const result: Row[] = []

  if (groupBy === 'none') {
    for (const w of worktrees) {
      result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) })
    }
    return result
  }

  const grouped = new Map<string, { label: string; items: Worktree[]; repo?: Repo }>()
  for (const w of worktrees) {
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
    orderedGroups.push(...Array.from(grouped.entries()))
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

/**
 * Returns true when the worktree matches the search query against any of:
 * displayName, branch, repo name, comment, PR number/title, issue number/title.
 * `q` must already be lowercased by the caller.
 */
export function matchesSearch(
  w: Worktree,
  q: string,
  repoMap: Map<string, Repo>,
  prCache: Record<string, { data?: { number: number; title: string } | null }> | null,
  issueCache: Record<string, { data?: { number: number; title: string } | null }> | null
): boolean {
  // Cheap field checks first
  if (w.displayName.toLowerCase().includes(q)) {
    return true
  }
  if (branchName(w.branch).toLowerCase().includes(q)) {
    return true
  }
  if ((repoMap.get(w.repoId)?.displayName ?? '').toLowerCase().includes(q)) {
    return true
  }
  if (w.comment && w.comment.toLowerCase().includes(q)) {
    return true
  }

  // Strip leading '#' so that searching "#304" matches number 304.
  // Guard against bare '#' which would produce an empty string and match everything.
  const numQuery = q.startsWith('#') ? q.slice(1) : q
  if (!numQuery) {
    return false
  }

  // PR: check auto-detected PR from cache, then manual linkedPR as fallback
  const repo = repoMap.get(w.repoId)
  const branch = branchName(w.branch)
  const prKey = repo && branch ? `${repo.path}::${branch}` : ''
  const pr = prKey && prCache ? prCache[prKey]?.data : undefined

  if (pr) {
    if (String(pr.number).includes(numQuery)) {
      return true
    }
    if (pr.title.toLowerCase().includes(q)) {
      return true
    }
  } else if (w.linkedPR != null) {
    if (String(w.linkedPR).includes(numQuery)) {
      return true
    }
  }

  // Issue: check linkedIssue number and cached title
  if (w.linkedIssue != null) {
    if (String(w.linkedIssue).includes(numQuery)) {
      return true
    }
    const issueKey = repo ? `${repo.path}::${w.linkedIssue}` : ''
    const issue = issueKey && issueCache ? issueCache[issueKey]?.data : undefined
    if (issue?.title.toLowerCase().includes(q)) {
      return true
    }
  }

  return false
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
