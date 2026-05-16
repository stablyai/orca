/* eslint-disable max-lines -- Why: sidebar row construction keeps every grouping mode in one pure module so reveal, virtualized rendering, and tests share the same flat row contract. */
import { CircleCheckBig, CircleDot, CircleX, Folder, GitPullRequest, Pin } from 'lucide-react'
import type React from 'react'
import type {
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
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

export type WorktreeRow = {
  type: 'item'
  worktree: Worktree
  repo: Repo | undefined
  depth: number
  lineageTrail: boolean[]
  isLastLineageChild: boolean
  lineageChildCount: number
  lineageGroupKey?: string
  lineageCollapsed?: boolean
  parentLabel?: string
  lineageState?: 'valid' | 'missing'
}
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

export const MISSING_PARENT_GROUP_META = {
  label: 'Missing parent'
} as const

export const LINEAGE_GROUP_PREFIX = 'lineage:'

export function getLineageGroupKey(worktreeId: string): string {
  return `${LINEAGE_GROUP_PREFIX}${worktreeId}`
}

export type LineageRenderInfo =
  | { state: 'none' }
  | { state: 'valid'; lineage: WorktreeLineage; parent: Worktree }
  | { state: 'missing'; lineage: WorktreeLineage }

export function getLineageRenderInfo(
  worktree: Worktree,
  lineageById: Record<string, WorktreeLineage>,
  worktreeMap: Map<string, Worktree>
): LineageRenderInfo {
  const lineage = lineageById[worktree.id]
  if (!lineage) {
    return { state: 'none' }
  }
  const parent = worktreeMap.get(lineage.parentWorktreeId)
  if (
    !parent ||
    worktree.instanceId !== lineage.worktreeInstanceId ||
    parent.instanceId !== lineage.parentWorktreeInstanceId
  ) {
    return { state: 'missing', lineage }
  }
  return { state: 'valid', lineage, parent }
}
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
  lineageById: Record<string, WorktreeLineage>,
  worktreeMap: Map<string, Worktree>,
  collapsedGroups: Set<string>,
  result: Row[],
  showLineageContext: boolean,
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
    appendWorktreeRows(result, pinned, repoMap, lineageById, worktreeMap, {
      nestLineage: false,
      showLineageContext,
      collapsedGroups
    })
  }
  return new Set(pinned.map((w) => w.id))
}

function buildWorktreeRow(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  lineageById: Record<string, WorktreeLineage>,
  worktreeMap: Map<string, Worktree>,
  showLineageContext: boolean,
  depth: number,
  lineageTrail: boolean[],
  isLastLineageChild: boolean,
  lineageChildCount: number,
  lineageCollapsed: boolean
): WorktreeRow {
  const lineage = showLineageContext
    ? getLineageRenderInfo(worktree, lineageById, worktreeMap)
    : { state: 'none' as const }
  return {
    type: 'item',
    worktree,
    repo: repoMap.get(worktree.repoId),
    depth,
    lineageTrail,
    isLastLineageChild,
    lineageChildCount,
    ...(lineageChildCount > 0 ? { lineageGroupKey: getLineageGroupKey(worktree.id) } : {}),
    ...(lineageChildCount > 0 ? { lineageCollapsed } : {}),
    ...(lineage.state === 'valid'
      ? { parentLabel: lineage.parent.displayName, lineageState: 'valid' as const }
      : lineage.state === 'missing'
        ? { parentLabel: MISSING_PARENT_GROUP_META.label, lineageState: 'missing' as const }
        : {})
  }
}

function appendWorktreeRows(
  result: Row[],
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  lineageById: Record<string, WorktreeLineage>,
  worktreeMap: Map<string, Worktree>,
  options: {
    nestLineage: boolean
    showLineageContext: boolean
    collapsedGroups: Set<string>
  }
): void {
  const { nestLineage, showLineageContext, collapsedGroups } = options
  if (!nestLineage) {
    for (const worktree of worktrees) {
      result.push(
        buildWorktreeRow(
          worktree,
          repoMap,
          lineageById,
          worktreeMap,
          showLineageContext,
          0,
          [],
          false,
          0,
          false
        )
      )
    }
    return
  }

  const visibleIds = new Set(worktrees.map((worktree) => worktree.id))
  const childrenByParentId = new Map<string, Worktree[]>()
  const childIds = new Set<string>()
  for (const worktree of worktrees) {
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeMap)
    if (lineage.state !== 'valid' || !visibleIds.has(lineage.parent.id)) {
      continue
    }
    childIds.add(worktree.id)
    const children = childrenByParentId.get(lineage.parent.id) ?? []
    children.push(worktree)
    childrenByParentId.set(lineage.parent.id, children)
  }

  const emitted = new Set<string>()
  const emit = (
    worktree: Worktree,
    depth: number,
    lineageTrail: boolean[],
    isLastChild: boolean
  ): void => {
    if (emitted.has(worktree.id)) {
      return
    }
    const children = childrenByParentId.get(worktree.id) ?? []
    const lineageGroupKey = getLineageGroupKey(worktree.id)
    const lineageCollapsed = collapsedGroups.has(lineageGroupKey)
    emitted.add(worktree.id)
    result.push(
      buildWorktreeRow(
        worktree,
        repoMap,
        lineageById,
        worktreeMap,
        showLineageContext,
        depth,
        lineageTrail,
        isLastChild,
        children.length,
        lineageCollapsed
      )
    )
    if (lineageCollapsed) {
      return
    }
    children.forEach((child, index) => {
      emit(
        child,
        depth + 1,
        [...lineageTrail, index < children.length - 1],
        index === children.length - 1
      )
    })
  }

  const roots = worktrees.filter((worktree) => !childIds.has(worktree.id))
  for (const [index, worktree] of roots.entries()) {
    emit(worktree, 0, [], index === roots.length - 1)
  }
  if (roots.length === 0) {
    for (const worktree of worktrees) {
      if (!emitted.has(worktree.id)) {
        // Why: malformed cyclic lineage should not hide every participant.
        // Render any leftovers as roots rather than recursing forever.
        emit(worktree, 0, [], true)
      }
    }
  }
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
  repoGroupOrdering: RepoGroupOrdering = 'manual',
  lineageById: Record<string, WorktreeLineage> = {},
  worktreeMap: Map<string, Worktree> = new Map(
    worktrees.map((worktree) => [worktree.id, worktree])
  ),
  nestLineage = false
): Row[] {
  const result: Row[] = []

  const pinnedIds = emitPinnedGroup(
    worktrees,
    repoMap,
    lineageById,
    worktreeMap,
    collapsedGroups,
    result,
    nestLineage,
    groupBy === 'none'
  )
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
      appendWorktreeRows(result, group.items, repoMap, lineageById, worktreeMap, {
        nestLineage,
        showLineageContext: nestLineage,
        collapsedGroups
      })
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
