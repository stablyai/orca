/* eslint-disable max-lines -- Why: sidebar row construction keeps every grouping mode in one pure module so reveal, virtualized rendering, and tests share the same flat row contract. */
import { CircleX, FolderTree, List, Pin } from 'lucide-react'
import type React from 'react'
import type {
  DetectedWorktree,
  Project,
  ProjectHostSetup,
  FolderWorkspace,
  Repo,
  ProjectGroup,
  ProjectOrderBy,
  Worktree,
  WorktreeLineage,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import { branchName } from '../../lib/git-utils'
import {
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  getWorkspaceStatusVisualMeta
} from './workspace-status'
import {
  ConductorDoneIcon,
  ConductorProgressIcon,
  ConductorReviewIcon
} from './workspace-status-icons'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { AppState } from '../../store/types'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from '../../store/slices/github-cache-key'
import { UNGROUPED_PROJECT_GROUP_KEY } from '../../../../shared/project-groups'
import { getRepoDisplayLabelsByPath } from '@/lib/repo-display-labels'
import { translate } from '@/i18n/i18n'
import { getExecutionHostLabel, getRepoExecutionHostId } from '../../../../shared/execution-host'

export { branchName }

export type WorktreeGroupBy = 'none' | 'workspace-status' | 'repo' | 'pr-status'

export type GroupHeaderRow = {
  type: 'header'
  key: string
  label: string
  count: number
  tone: string
  icon?: React.ComponentType<{ className?: string }>
  repo?: Repo
  projectGroup?: ProjectGroup | { id: null; name: 'Ungrouped'; tabOrder: number }
  projectGroupDepth?: number
}

export type WorktreeRow = {
  type: 'item'
  worktree: Worktree
  repo: Repo | undefined
  depth: number
  groupDepth: number
  lineageTrail: boolean[]
  isLastLineageChild: boolean
  lineageChildCount: number
  lineageGroupKey?: string
  lineageCollapsed?: boolean
  hostContextLabel?: string
}

export type ImportedWorktreesCardCandidate = {
  repo: Repo
  hiddenWorktrees: DetectedWorktree[]
}

export type ImportedWorktreesCardRow = {
  type: 'imported-worktrees-card'
  key: string
  repo: Repo
  hiddenWorktrees: DetectedWorktree[]
  placement: 'repo-group' | 'pinned-fallback'
}

export type PendingCreationRow = {
  type: 'pending-creation'
  key: string
  creationId: string
  repo: Repo | undefined
}

export type FolderWorkspaceRow = {
  type: 'folder-workspace'
  key: string
  folderWorkspace: FolderWorkspace
  projectGroup: ProjectGroup
  depth: number
  groupDepth: number
}

/** Minimal shape buildRows needs for an in-flight create. Deliberately not the
 *  full PendingWorktreeCreation: row identity depends only on which creates
 *  exist and their repo, so callers can subscribe on this stable shape and keep
 *  progress-field churn (phase/loaderVisible) from rebuilding the whole list. */
export type PendingCreationRef = { creationId: string; repoId: string }

export type Row =
  | GroupHeaderRow
  | WorktreeRow
  | ImportedWorktreesCardRow
  | PendingCreationRow
  | FolderWorkspaceRow

function buildPendingCreationRow(
  creation: PendingCreationRef,
  repoMap: Map<string, Repo>
): PendingCreationRow {
  return {
    type: 'pending-creation',
    key: `pending:${creation.creationId}`,
    creationId: creation.creationId,
    repo: repoMap.get(creation.repoId)
  }
}

type OrderedGroupEntry = [string, WorktreeGroupEntry]

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

type WorktreeGroupEntry = {
  label: string
  items: Worktree[]
  repo?: Repo
  repoIds: Set<string>
}

type ProjectGroupingIndex = {
  projectById: Map<string, Project>
  setupByRepoId: Map<string, ProjectHostSetup>
  // Why: `${projectId}::${hostId}` pairs that back more than one setup — i.e. the
  // same project checked out multiple times on one host (independent clones or
  // worktrees). Those setups must not collapse into a single project group.
  multiSetupProjectHostKeys: Set<string>
}

function projectHostKey(projectId: string, hostId: string): string {
  return `${projectId}::${hostId}`
}

function buildProjectGroupingIndex(model?: ProjectGroupingModel): ProjectGroupingIndex | null {
  const projects = model?.projects ?? []
  const projectHostSetups = model?.projectHostSetups ?? []
  if (projects.length === 0 || projectHostSetups.length === 0) {
    return null
  }
  const setupCountByProjectHost = new Map<string, number>()
  for (const setup of projectHostSetups) {
    const key = projectHostKey(setup.projectId, setup.hostId)
    setupCountByProjectHost.set(key, (setupCountByProjectHost.get(key) ?? 0) + 1)
  }
  const multiSetupProjectHostKeys = new Set<string>()
  for (const [key, count] of setupCountByProjectHost) {
    if (count > 1) {
      multiSetupProjectHostKeys.add(key)
    }
  }
  return {
    projectById: new Map(projects.map((project) => [project.id, project])),
    setupByRepoId: new Map(projectHostSetups.map((setup) => [setup.repoId, setup])),
    multiSetupProjectHostKeys
  }
}

function getProjectGroupingForRepo(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): { key: string; label: string; repo?: Repo; projectId?: string } {
  const repo = repoMap.get(repoId)
  const setup = projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  if (projectIndex?.multiSetupProjectHostKeys.has(projectHostKey(setup.projectId, setup.hostId))) {
    // Why: this project is set up more than once on this host, so each checkout
    // keeps its own group (labelled by its folder) instead of collapsing into a
    // single project header named after whichever folder was added first.
    return {
      key: `project:${project.id}::setup:${repoId}`,
      label: repo?.displayName ?? setup.displayName,
      repo,
      projectId: project.id
    }
  }
  return {
    key: `project:${project.id}`,
    label: project.displayName,
    repo,
    projectId: project.id
  }
}

function addRepoIdToGroup(group: WorktreeGroupEntry, repoId: string): void {
  group.repoIds.add(repoId)
}

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
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.5076efc3d2', 'Done')
    },
    icon: ConductorDoneIcon,
    tone: 'text-[#c7a594]'
  },
  'in-review': {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.6798dc7c94', 'In review')
    },
    icon: ConductorReviewIcon,
    tone: 'text-[#16a34a]'
  },
  'in-progress': {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.7c2f009786', 'In progress')
    },
    icon: ConductorProgressIcon,
    tone: 'text-[#d4a300]'
  },
  closed: {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.682ed5d551', 'Closed')
    },
    icon: CircleX,
    tone: 'text-zinc-600 dark:text-zinc-300'
  }
}

export const PROJECT_GROUP_META = {
  tone: 'text-foreground',
  icon: FolderTree
} as const

export function getProjectGroupHeaderKey(groupId: string | null): string {
  return groupId ? `project-group:${groupId}` : UNGROUPED_PROJECT_GROUP_KEY
}

export const PINNED_GROUP_KEY = 'pinned'

export const PINNED_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.4aeefc5996', 'Pinned')
  },
  tone: 'text-foreground',
  icon: Pin
} as const

export const ALL_GROUP_KEY = 'all'

export const ALL_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.0ed04075b8', 'All')
  },
  tone: 'text-foreground',
  icon: List
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
  prCache: Record<string, unknown> | null,
  settings?: AppState['settings']
): PRGroupKey {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  const repoScopedCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId
        )
      : ''
  const canUseLegacyPRCache =
    repo !== undefined && !settings?.activeRuntimeEnvironmentId?.trim() && !repo.connectionId
  const legacyRepoScopedCacheKey =
    canUseLegacyPRCache && branch ? getLegacyGitHubPRCacheKey(repo.path, repo.id, branch) : ''
  const legacyPathScopedCacheKey =
    canUseLegacyPRCache && branch ? getLegacyGitHubPRCacheKey(repo.path, undefined, branch) : ''
  // Why: PR refreshes now write repo-id scoped entries; legacy path entries may
  // still exist from persisted cache, but must not override fresher repo data.
  const prEntry = prCache
    ? ((repoScopedCacheKey
        ? (prCache[repoScopedCacheKey] as { data?: { state?: string } } | undefined)
        : undefined) ??
      (legacyRepoScopedCacheKey
        ? (prCache[legacyRepoScopedCacheKey] as { data?: { state?: string } } | undefined)
        : undefined) ??
      (legacyPathScopedCacheKey
        ? (prCache[legacyPathScopedCacheKey] as { data?: { state?: string } } | undefined)
        : undefined))
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
  visibleUnpinnedRepoIds: ReadonlySet<string>,
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>,
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
    const lastPinnedIndexByRepoId = new Map<string, number>()
    pinned.forEach((worktree, index) => lastPinnedIndexByRepoId.set(worktree.repoId, index))
    for (const [index, worktree] of pinned.entries()) {
      result.push(buildWorktreeRow(worktree, repoMap, 0, 0, [], false, 0, false))
      const candidate = importedWorktreesByRepo.get(worktree.repoId)
      if (
        candidate &&
        !visibleUnpinnedRepoIds.has(worktree.repoId) &&
        lastPinnedIndexByRepoId.get(worktree.repoId) === index
      ) {
        result.push(buildImportedWorktreesCardRow(candidate, 'pinned-fallback'))
      }
    }
  }
  return new Set(pinned.map((w) => w.id))
}

function buildImportedWorktreesCardRow(
  candidate: ImportedWorktreesCardCandidate,
  placement: ImportedWorktreesCardRow['placement']
): ImportedWorktreesCardRow {
  return {
    type: 'imported-worktrees-card',
    key: `imported-worktrees-card:${placement}:${candidate.repo.id}`,
    repo: candidate.repo,
    hiddenWorktrees: candidate.hiddenWorktrees,
    placement
  }
}

function buildWorktreeRow(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  depth: number,
  groupDepth: number,
  lineageTrail: boolean[],
  isLastLineageChild: boolean,
  lineageChildCount: number,
  lineageCollapsed: boolean,
  hostContextLabel?: string
): WorktreeRow {
  return {
    type: 'item',
    worktree,
    repo: repoMap.get(worktree.repoId),
    depth,
    groupDepth,
    lineageTrail,
    isLastLineageChild,
    lineageChildCount,
    ...(hostContextLabel ? { hostContextLabel } : {}),
    ...(lineageChildCount > 0 ? { lineageGroupKey: getLineageGroupKey(worktree.id) } : {}),
    ...(lineageChildCount > 0 ? { lineageCollapsed } : {})
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
    collapsedGroups: Set<string>
    groupDepth: number
    hostContextLabelByRepoId?: ReadonlyMap<string, string>
  }
): void {
  const { nestLineage, collapsedGroups, groupDepth, hostContextLabelByRepoId } = options
  if (!nestLineage) {
    for (const worktree of worktrees) {
      result.push(
        buildWorktreeRow(
          worktree,
          repoMap,
          0,
          groupDepth,
          [],
          false,
          0,
          false,
          hostContextLabelByRepoId?.get(worktree.repoId)
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
        depth,
        groupDepth,
        lineageTrail,
        isLastChild,
        children.length,
        lineageCollapsed,
        hostContextLabelByRepoId?.get(worktree.repoId)
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

function getRepoHostLabel(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): string | null {
  const setup = projectIndex?.setupByRepoId.get(repoId)
  if (setup) {
    return hostLabelById?.get(setup.hostId) ?? getExecutionHostLabel(setup.hostId)
  }
  const repo = repoMap.get(repoId)
  if (!repo) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  return hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
}

function getMixedHostContextLabels(
  group: WorktreeGroupEntry,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): Map<string, string> | undefined {
  const labelsByRepoId = new Map<string, string>()
  const uniqueLabels = new Set<string>()
  for (const repoId of group.repoIds) {
    const label = getRepoHostLabel(repoId, repoMap, projectIndex, hostLabelById)
    if (!label) {
      continue
    }
    labelsByRepoId.set(repoId, label)
    uniqueLabels.add(label)
  }
  return uniqueLabels.size > 1 ? labelsByRepoId : undefined
}

function orderMainWorktreeFirst(worktrees: Worktree[]): Worktree[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Why: project groups are scanned by repo; keep the repo's canonical
  // workspace anchored even when dynamic sorts rank a child workspace first.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}

function withRepoSectionDisplayLabels(entries: readonly OrderedGroupEntry[]): OrderedGroupEntry[] {
  const repos = entries
    .map((entry) => entry[1].repo)
    .filter((repo): repo is Repo => repo !== undefined)
  if (repos.length < 2) {
    return [...entries]
  }
  const labelsByPath = getRepoDisplayLabelsByPath(repos)
  return entries.map(([key, group]) => [
    key,
    group.repo ? { ...group, label: labelsByPath.get(group.repo.path) ?? group.label } : group
  ])
}

/**
 * Recent rank for a project header. `hasActivity` projects (at least one
 * visible worktree) always sort before fallback projects, regardless of the
 * numeric values — a placeholder's `addedAt` must never outrank real activity.
 * Within each tier, higher timestamps come first.
 */
type RecentRank = { hasActivity: boolean; ts: number }

function recentRankForEntry(entry: OrderedGroupEntry): RecentRank {
  let max = Number.NEGATIVE_INFINITY
  for (const worktree of entry[1].items) {
    if (worktree.lastActivityAt > max) {
      max = worktree.lastActivityAt
    }
  }
  if (max !== Number.NEGATIVE_INFINITY) {
    // Why: Recent must be timestamp-based, not encounter order — the incoming
    // array is no longer pre-sorted by recency once decoupled from sortBy.
    return { hasActivity: true, ts: max }
  }
  const addedAt = entry[1].repo?.addedAt
  return {
    hasActivity: false,
    ts: typeof addedAt === 'number' ? addedAt : Number.NEGATIVE_INFINITY
  }
}

function compareRecentRank(a: RecentRank, b: RecentRank): number {
  if (a.hasActivity !== b.hasActivity) {
    return a.hasActivity ? -1 : 1
  }
  return b.ts - a.ts
}

function manualRankForEntry(
  entry: OrderedGroupEntry,
  repoOrder: Map<string, number> | undefined
): number {
  const key = entry[0]
  const repoId = key.startsWith('repo:') ? key.slice('repo:'.length) : key
  const rank = repoOrder?.get(repoId)
  return rank === undefined ? Number.POSITIVE_INFINITY : rank
}

/**
 * Order project header entries by the user's project-order preference. Manual
 * follows the canonical repoOrder; Recent follows each project's most recent
 * visible workspace activity (descending), with empty/imported-only projects
 * sorting after active ones, then by manual rank, then label.
 */
function sortProjectEntries(
  entries: OrderedGroupEntry[],
  projectOrderBy: ProjectOrderBy,
  repoOrder: Map<string, number> | undefined
): OrderedGroupEntry[] {
  if (projectOrderBy === 'recent') {
    return [...entries].sort((a, b) => {
      const byRecent = compareRecentRank(recentRankForEntry(a), recentRankForEntry(b))
      if (byRecent !== 0) {
        return byRecent
      }
      const ma = manualRankForEntry(a, repoOrder)
      const mb = manualRankForEntry(b, repoOrder)
      if (ma !== mb) {
        return ma - mb
      }
      return a[1].label.localeCompare(b[1].label)
    })
  }
  if (!repoOrder) {
    return entries
  }
  return [...entries].sort((a, b) => {
    const ra = manualRankForEntry(a, repoOrder)
    const rb = manualRankForEntry(b, repoOrder)
    if (ra !== rb) {
      return ra - rb
    }
    return a[1].label.localeCompare(b[1].label)
  })
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
  projectOrderBy: ProjectOrderBy = 'manual',
  lineageById: Record<string, WorktreeLineage> = {},
  worktreeMap: Map<string, Worktree> = new Map(
    worktrees.map((worktree) => [worktree.id, worktree])
  ),
  nestLineage = false,
  settings?: AppState['settings'],
  projectGroups: readonly ProjectGroup[] = [],
  placeholderRepoIds: ReadonlySet<string> = new Set(),
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate> = new Map(),
  pendingCreations: readonly PendingCreationRef[] = [],
  projectGrouping?: ProjectGroupingModel,
  folderWorkspaces: readonly FolderWorkspace[] = [],
  hostLabelById?: ReadonlyMap<string, string>
): Row[] {
  const result: Row[] = []
  const projectIndex = buildProjectGroupingIndex(projectGrouping)

  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }

  // Why: non-repo groupings have no repo section to nest an in-progress create
  // under, so surface them at the very top (where the old global strip sat)
  // rather than dropping them. Repo grouping nests them under their repo below.
  if (groupBy !== 'repo' && pendingCreations.length > 0) {
    for (const creation of pendingCreations) {
      result.push(buildPendingCreationRow(creation, repoMap))
    }
  }

  const visibleUnpinnedRepoIds = new Set(
    worktrees.filter((worktree) => !worktree.isPinned).map((worktree) => worktree.repoId)
  )
  const visiblePinnedRepoIds = new Set(
    worktrees.filter((worktree) => worktree.isPinned).map((worktree) => worktree.repoId)
  )
  const pinnedIds = emitPinnedGroup(
    worktrees,
    repoMap,
    collapsedGroups,
    visibleUnpinnedRepoIds,
    importedWorktreesByRepo,
    result
  )
  const unpinned = pinnedIds.size > 0 ? worktrees.filter((w) => !pinnedIds.has(w.id)) : worktrees

  if (groupBy === 'none') {
    if (unpinned.length > 0) {
      result.push({
        type: 'header',
        key: ALL_GROUP_KEY,
        label: ALL_GROUP_META.label,
        count: unpinned.length,
        tone: ALL_GROUP_META.tone,
        icon: ALL_GROUP_META.icon
      })
      if (!collapsedGroups.has(ALL_GROUP_KEY)) {
        appendWorktreeRows(result, unpinned, repoMap, lineageById, worktreeMap, {
          nestLineage,
          collapsedGroups,
          groupDepth: 0
        })
      }
    }
    return result
  }

  const grouped = new Map<string, WorktreeGroupEntry>()
  for (const w of unpinned) {
    let key: string
    let label: string
    let repo: Repo | undefined
    if (groupBy === 'repo') {
      const grouping = getProjectGroupingForRepo(w.repoId, repoMap, projectIndex)
      key = grouping.key
      label = grouping.label
      repo = grouping.repo
    } else if (groupBy === 'workspace-status') {
      const workspaceStatus = getWorkspaceStatus(w, workspaceStatuses)
      key = getWorkspaceStatusGroupKey(workspaceStatus)
      label =
        workspaceStatuses.find((status) => status.id === workspaceStatus)?.label ?? workspaceStatus
    } else {
      const prGroup = getPRGroupKey(w, repoMap, prCache, settings)
      key = `pr:${prGroup}`
      label = PR_GROUP_META[prGroup].label
    }
    if (!grouped.has(key)) {
      grouped.set(key, { label, items: [], repo, repoIds: new Set() })
    }
    const group = grouped.get(key)!
    group.items.push(w)
    addRepoIdToGroup(group, w.repoId)
  }
  if (groupBy === 'repo') {
    for (const repoId of placeholderRepoIds) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      if (!grouping.repo) {
        continue
      }
      const key = grouping.key
      if (!grouped.has(key)) {
        // Why: repos can arrive before worktree scans, but stale IDs passed by
        // older snapshots must not render an "Unknown" project header.
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo,
          repoIds: new Set([repoId])
        })
      } else {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
  }
  if (groupBy === 'repo') {
    for (const [repoId, candidate] of importedWorktreesByRepo) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      const key = grouping.key
      if (!grouped.has(key) && !visiblePinnedRepoIds.has(repoId)) {
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo ?? candidate.repo,
          repoIds: new Set([repoId])
        })
      } else if (grouped.has(key)) {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
  }
  if (groupBy === 'repo') {
    for (const repoId of pendingByRepo.keys()) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      const key = grouping.key
      if (!grouped.has(key)) {
        // Why: creating the first worktree in a repo leaves it with no group yet;
        // ensure one so the in-progress row nests under its repo instead of being
        // dropped.
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo,
          repoIds: new Set([repoId])
        })
      } else {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
  }

  const orderedGroups: OrderedGroupEntry[] = []
  if (groupBy === 'pr-status') {
    for (const prGroup of PR_GROUP_ORDER) {
      const key = `pr:${prGroup}`
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else if (groupBy === 'workspace-status') {
    // Why: status grouping is opt-in while the board drawer remains the wider
    // all-lanes drag target; keep the sidebar compact by omitting empty lanes.
    for (const status of workspaceStatuses) {
      const key = getWorkspaceStatusGroupKey(status.id)
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else {
    // Why: project header order is its own user choice (projectOrderBy),
    // decoupled from workspace sortBy. Manual uses the canonical repoOrder so
    // header drag has a stable source of truth; Recent follows activity.
    const entries = sortProjectEntries(Array.from(grouped.entries()), projectOrderBy, repoOrder)
    // Why: large imported repo sets can have one group per repo; spreading
    // those entries into push can exceed V8's argument limit.
    for (const entry of entries) {
      orderedGroups.push(entry)
    }
  }

  const appendOrderedGroups = (
    groupsToAppend: OrderedGroupEntry[],
    projectGroupDepth = 0
  ): void => {
    for (const [key, group] of groupsToAppend) {
      const isCollapsed = collapsedGroups.has(key)
      const repo = group.repo
      const header =
        groupBy === 'repo'
          ? {
              type: 'header' as const,
              key,
              label: group.label,
              count: group.items.length,
              tone: PROJECT_GROUP_META.tone,
              icon: PROJECT_GROUP_META.icon,
              repo,
              projectGroupDepth
            }
          : groupBy === 'workspace-status'
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
        if (groupBy === 'repo') {
          const repoIds =
            group.repoIds.size > 0
              ? [...group.repoIds]
              : repo
                ? [repo.id]
                : key.startsWith('repo:')
                  ? [key.slice('repo:'.length)]
                  : []
          for (const repoId of repoIds) {
            const candidate = importedWorktreesByRepo.get(repoId)
            if (candidate) {
              result.push(buildImportedWorktreesCardRow(candidate, 'repo-group'))
            }
          }
          // Why: surface in-progress creates at the top of their own repo so the
          // new workspace appears where it will land, not flashed to the very top
          // of the sidebar.
          for (const repoId of repoIds) {
            for (const creation of pendingByRepo.get(repoId) ?? []) {
              result.push(buildPendingCreationRow(creation, repoMap))
            }
          }
        }
        const items = groupBy === 'repo' ? orderMainWorktreeFirst(group.items) : group.items
        const hostContextLabelByRepoId =
          groupBy === 'repo'
            ? getMixedHostContextLabels(group, repoMap, projectIndex, hostLabelById)
            : undefined
        appendWorktreeRows(result, items, repoMap, lineageById, worktreeMap, {
          nestLineage,
          collapsedGroups,
          groupDepth: projectGroupDepth,
          hostContextLabelByRepoId
        })
      }
    }
  }

  if (groupBy !== 'repo' || projectGroups.length === 0) {
    appendOrderedGroups(
      groupBy === 'repo' ? withRepoSectionDisplayLabels(orderedGroups) : orderedGroups
    )
    return result
  }

  const groupByProjectGroupId = new Map<string | null, OrderedGroupEntry[]>()
  for (const entry of orderedGroups) {
    const repo = entry[1].repo
    const projectGroupId = repo?.projectGroupId ?? null
    const list = groupByProjectGroupId.get(projectGroupId) ?? []
    list.push(entry)
    groupByProjectGroupId.set(projectGroupId, list)
  }

  const sortRepoEntriesWithinGroup = (entries: OrderedGroupEntry[]): OrderedGroupEntry[] => {
    if (projectOrderBy === 'recent') {
      return [...entries].sort((left, right) =>
        compareRecentRank(recentRankForEntry(left), recentRankForEntry(right))
      )
    }
    // Manual: within a Project Group, projects order by their per-group rank
    // (projectGroupOrder), not the global repoOrder.
    return [...entries].sort((left, right) => {
      const leftOrder = left[1].repo?.projectGroupOrder
      const rightOrder = right[1].repo?.projectGroupOrder
      const leftRank =
        typeof leftOrder === 'number' && Number.isFinite(leftOrder)
          ? leftOrder
          : Number.POSITIVE_INFINITY
      const rightRank =
        typeof rightOrder === 'number' && Number.isFinite(rightOrder)
          ? rightOrder
          : Number.POSITIVE_INFINITY
      return leftRank - rightRank
    })
  }

  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const folderWorkspacesByProjectGroupId = new Map<string, FolderWorkspace[]>()
  for (const workspace of folderWorkspaces) {
    const group = projectGroupsById.get(workspace.projectGroupId)
    if (!group?.parentPath) {
      continue
    }
    const list = folderWorkspacesByProjectGroupId.get(workspace.projectGroupId) ?? []
    list.push(workspace)
    folderWorkspacesByProjectGroupId.set(workspace.projectGroupId, list)
  }
  for (const list of folderWorkspacesByProjectGroupId.values()) {
    list.sort((left, right) => {
      const leftOrder = left.manualOrder ?? left.sortOrder
      const rightOrder = right.manualOrder ?? right.sortOrder
      return rightOrder - leftOrder || left.name.localeCompare(right.name)
    })
  }
  const childGroupsByParentId = new Map<string | null, ProjectGroup[]>()
  for (const group of projectGroups) {
    const parentId =
      group.parentGroupId && projectGroupsById.has(group.parentGroupId) ? group.parentGroupId : null
    const children = childGroupsByParentId.get(parentId) ?? []
    children.push(group)
    childGroupsByParentId.set(parentId, children)
  }
  for (const groups of childGroupsByParentId.values()) {
    groups.sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  const getProjectGroupSubtreeCount = (groupId: string): number => {
    const directCount = groupByProjectGroupId.get(groupId)?.length ?? 0
    const folderWorkspaceCount = folderWorkspacesByProjectGroupId.get(groupId)?.length ?? 0
    const children = childGroupsByParentId.get(groupId) ?? []
    return children.reduce(
      (count, child) => count + getProjectGroupSubtreeCount(child.id),
      directCount + folderWorkspaceCount
    )
  }

  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    const childGroups = childGroupsByParentId.get(projectGroup.id) ?? []
    const key = getProjectGroupHeaderKey(projectGroup.id)
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(projectGroup.id),
      tone: PROJECT_GROUP_META.tone,
      icon: PROJECT_GROUP_META.icon,
      projectGroup,
      projectGroupDepth: depth
    })
    if (!collapsedGroups.has(key)) {
      for (const folderWorkspace of folderWorkspacesByProjectGroupId.get(projectGroup.id) ?? []) {
        result.push({
          type: 'folder-workspace',
          key: `folder-workspace:${folderWorkspace.id}`,
          folderWorkspace,
          projectGroup,
          depth: 0,
          groupDepth: depth + 1
        })
      }
      appendOrderedGroups(withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroups) {
        appendProjectGroup(childGroup, depth + 1)
      }
    }
    groupByProjectGroupId.delete(projectGroup.id)
  }

  for (const projectGroup of childGroupsByParentId.get(null) ?? []) {
    appendProjectGroup(projectGroup, 0)
  }

  appendOrderedGroups(
    withRepoSectionDisplayLabels(sortRepoEntriesWithinGroup(groupByProjectGroupId.get(null) ?? [])),
    0
  )

  return result
}

export function getGroupKeyForWorktree(
  groupBy: WorktreeGroupBy,
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  settings?: AppState['settings'],
  projectGrouping?: ProjectGroupingModel
): string | null {
  if (groupBy === 'none') {
    return ALL_GROUP_KEY
  }
  if (groupBy === 'workspace-status') {
    return getWorkspaceStatusGroupKey(getWorkspaceStatus(worktree, workspaceStatuses))
  }
  if (groupBy === 'repo') {
    return getProjectGroupingForRepo(
      worktree.repoId,
      repoMap,
      buildProjectGroupingIndex(projectGrouping)
    ).key
  }
  return `pr:${getPRGroupKey(worktree, repoMap, prCache, settings)}`
}

export function getGroupKeysForWorktree(
  groupBy: WorktreeGroupBy,
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  settings?: AppState['settings'],
  projectGroups: readonly ProjectGroup[] = [],
  projectGrouping?: ProjectGroupingModel
): string[] {
  const groupKey = getGroupKeyForWorktree(
    groupBy,
    worktree,
    repoMap,
    prCache,
    workspaceStatuses,
    settings,
    projectGrouping
  )
  if (!groupKey) {
    return []
  }
  if (groupBy !== 'repo') {
    return [groupKey]
  }
  const repo = repoMap.get(worktree.repoId)
  const groupIds: string[] = []
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const visited = new Set<string>()
  let currentGroupId = repo?.projectGroupId ?? null
  while (currentGroupId && !visited.has(currentGroupId)) {
    visited.add(currentGroupId)
    groupIds.unshift(currentGroupId)
    const parentId = groupsById.get(currentGroupId)?.parentGroupId ?? null
    currentGroupId = parentId && groupsById.has(parentId) ? parentId : null
  }
  return [...groupIds.map((id) => getProjectGroupHeaderKey(id)), groupKey]
}
