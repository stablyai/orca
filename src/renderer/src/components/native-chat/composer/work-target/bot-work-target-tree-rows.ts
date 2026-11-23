import {
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'

export type BotWorkTargetHostUnavailableReason = 'offline' | 'other-host'

export type BotWorkTargetTreeRow = {
  /** Stable compound identity distinguishing same-name targets across hosts. */
  id: string
  /** Parent project row ID for child workspace rows; null for top-level rows. */
  parentRowId: string | null
  depth: number
  kind: 'project' | 'workspace'
  repoKind?: 'git' | 'folder'
  workspaceKind?: 'git-worktree' | 'folder'
  isMainWorktree?: boolean
  displayName: string
  /** Branch name or secondary context shown beside the row title. */
  detail?: string
  hostId: ExecutionHostId
  hostLabel: string
  /** True when another visible target shares the same displayName. */
  ambiguousName: boolean
  /** Absent when selectable; present when host is offline or unreachable from this bot. */
  unavailableReason?: BotWorkTargetHostUnavailableReason
  searchText: string
  target: AgentJournalWorkTarget
}

export function resolveHostLabel(
  hostId: ExecutionHostId,
  runtimeEnvNames: ReadonlyMap<string, string>,
  sshTargetLabels: ReadonlyMap<string, string>
): string {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed || parsed.kind === 'local') {
    return 'Local'
  }
  if (parsed.kind === 'runtime') {
    return runtimeEnvNames.get(parsed.environmentId) || getExecutionHostLabel(hostId)
  }
  return sshTargetLabels.get(parsed.targetId)?.trim() || getExecutionHostLabel(hostId)
}

function isRuntimeEnvironmentOffline(entry: RuntimeEnvironmentStatus | undefined): boolean {
  if (!entry) {
    return true
  }
  if (entry.snapshot) {
    return entry.snapshot.verification !== 'verified' || entry.snapshot.retired === true
  }
  return entry.status === null
}

export function resolveHostUnavailableReason(
  botHostId: ExecutionHostId,
  targetHostId: ExecutionHostId,
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>,
  sshConnectionStates: ReadonlyMap<string, { status: string }>
): BotWorkTargetHostUnavailableReason | undefined {
  if (botHostId !== LOCAL_EXECUTION_HOST_ID) {
    // A bot running on a remote paired server can only place workers on its own host.
    return targetHostId === botHostId ? undefined : 'other-host'
  }
  const parsed = parseExecutionHostId(targetHostId)
  if (!parsed || parsed.kind === 'local') {
    return undefined
  }
  if (parsed.kind === 'ssh') {
    const state = sshConnectionStates.get(parsed.targetId)
    return state && state.status !== 'connected' ? 'offline' : undefined
  }
  return isRuntimeEnvironmentOffline(runtimeStatusByEnvironmentId.get(parsed.environmentId))
    ? 'offline'
    : undefined
}

export function compactPathTail(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) {
    return normalized
  }
  return `…/${parts.slice(-2).join('/')}`
}

/** Order worktrees as a parent-child tree with main checkout first and archived rows excluded. */
export function buildWorktreeSubtreeRows(
  worktrees: readonly Worktree[],
  worktreeLineageById: Readonly<
    Record<string, Pick<WorktreeLineage, 'parentWorktreeId'> | undefined>
  >,
  repo: Repo,
  projectRowId: string,
  projectId: string | undefined,
  hostId: ExecutionHostId,
  hostLabel: string,
  unavailableReason: BotWorkTargetHostUnavailableReason | undefined
): BotWorkTargetTreeRow[] {
  const live = worktrees.filter((worktree) => !worktree.isArchived)
  if (live.length === 0) {
    return []
  }
  const byId = new Map(live.map((worktree) => [worktree.id, worktree]))
  const childrenByParent = new Map<string | null, Worktree[]>()
  for (const worktree of live) {
    const rawParentId = worktreeLineageById[worktree.id]?.parentWorktreeId
    const parentId = rawParentId && byId.has(rawParentId) ? rawParentId : null
    const bucket = childrenByParent.get(parentId) ?? []
    bucket.push(worktree)
    childrenByParent.set(parentId, bucket)
  }
  const sortWorktrees = (list: Worktree[]): Worktree[] =>
    list.sort((a, b) => {
      if (a.isMainWorktree !== b.isMainWorktree) {
        return a.isMainWorktree ? -1 : 1
      }
      return (
        (a.displayName || a.branch || a.id).localeCompare(b.displayName || b.branch || b.id) ||
        a.id.localeCompare(b.id)
      )
    })

  const rows: BotWorkTargetTreeRow[] = []
  const visited = new Set<string>()
  const visit = (parentId: string | null, depth: number): void => {
    const children = sortWorktrees([...(childrenByParent.get(parentId) ?? [])])
    for (const worktree of children) {
      if (visited.has(worktree.id)) {
        continue
      }
      visited.add(worktree.id)
      const label = worktree.displayName || worktree.branch || repo.displayName
      const branch = worktree.branch?.replace(/^refs\/heads\//, '') || undefined
      const detail =
        branch && branch !== label ? branch : worktree.isMainWorktree ? 'Main' : undefined
      const target: AgentJournalWorkTarget = {
        kind: 'workspace',
        hostId,
        ...(projectId ? { projectId } : {}),
        repoId: repo.id,
        repoKind: isFolderRepo(repo) ? 'folder' : 'git',
        workspaceId: worktree.id,
        workspaceKind: isFolderRepo(repo) ? 'folder' : 'git-worktree',
        displayName: label,
        projectName: repo.displayName,
        hostLabel
      }
      rows.push({
        id: `workspace:${hostId}:${worktree.id}`,
        parentRowId: projectRowId,
        depth,
        kind: 'workspace',
        repoKind: target.repoKind,
        workspaceKind: target.workspaceKind,
        isMainWorktree: worktree.isMainWorktree,
        displayName: label,
        ...(detail ? { detail } : {}),
        hostId,
        hostLabel,
        ambiguousName: false,
        ...(unavailableReason ? { unavailableReason } : {}),
        searchText: [label, branch, repo.displayName, hostLabel, worktree.path]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        target
      })
      visit(worktree.id, Math.min(depth + 1, 4))
    }
  }
  visit(null, 1)
  return rows
}

/** Filter tree rows by multi-token query while retaining parent/child tree context. */
export function filterBotWorkTargetTree(
  rows: readonly BotWorkTargetTreeRow[],
  rawQuery: string
): BotWorkTargetTreeRow[] {
  const tokens = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return [...rows]
  }
  const directMatchIds = new Set<string>()
  const matchedParentIds = new Set<string>()
  const includedParentIds = new Set<string>()
  for (const row of rows) {
    if (tokens.every((token) => row.searchText.includes(token))) {
      directMatchIds.add(row.id)
      if (row.parentRowId === null && row.kind === 'project') {
        matchedParentIds.add(row.id)
      }
      if (row.parentRowId) {
        includedParentIds.add(row.parentRowId)
      }
    }
  }
  return rows.filter(
    (row) =>
      directMatchIds.has(row.id) ||
      includedParentIds.has(row.id) ||
      (row.parentRowId !== null && matchedParentIds.has(row.parentRowId))
  )
}
