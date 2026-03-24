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
    tone: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  },
  'in-review': {
    label: 'In review',
    icon: GitPullRequest,
    tone: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  },
  'in-progress': {
    label: 'In progress',
    icon: CircleDot,
    tone: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  },
  closed: {
    label: 'Closed',
    icon: CircleX,
    tone: 'border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300'
  }
}

export const REPO_GROUP_META = {
  tone: 'border-border/70 bg-background/70 text-foreground',
  icon: FolderGit2
} as const

export function getPRGroupKey(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null
): PRGroupKey {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  const cacheKey = repo ? `${repo.path}::${branch}` : ''
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
