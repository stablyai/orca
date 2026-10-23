import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { isRuntimeHost } from './repo-removal-host-twin-attribution'
import { collectPtyIdsForTab } from '../slices/terminal-tab-retirement'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../../shared/worktree/host-qualified-identity'
import {
  getWorktreeIdFromVisitKey,
  removeWorktreeVisitEntriesForTargets
} from '@/lib/worktree-visit-recency'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../slices/worktrees/listing/worktree-host-ownership'
import { workspacePublishingHosts } from '../slices/worktrees/teardown/host-twin-worktree-purge'
import { selectDetectedWorktreesByRepo, selectWorktreesByRepo } from '../workspace-record-selectors'

export type RepoCatalogOwnerRemoval = {
  rows: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>
  purgeTargets: HostWorktreeTarget[]
  historyTargets: HostWorktreeTarget[]
  exclusiveIds: string[]
}

function isRepoWorkspace(id: string): boolean {
  const scope = parseWorkspaceKey(id)
  return (!scope || scope.type === 'worktree') && id.includes('::')
}

function hasUnlistedSibling(s: AppState, id: string, hostId: ExecutionHostId): boolean {
  const publishers = workspacePublishingHosts(s, id)
  const sessionHosts = Object.keys(s.lastVisitedAtByWorktreeId).flatMap((key) =>
    getWorktreeIdFromVisitKey(key) === id
      ? (getExecutionHostIdFromWorktreeHostIdentity(key) ?? [])
      : []
  )
  if (s.activeWorktreeId === id && s.activeWorkspaceExecutionHostId) {
    sessionHosts.push(s.activeWorkspaceExecutionHostId)
  }
  for (const [key, owner] of Object.entries(s.restoredRuntimeHostIdByWorkspaceSessionKey)) {
    if (normalizeWorkspaceSessionKeyToWorkspaceId(key) === id) {
      sessionHosts.push(owner)
    }
  }
  for (const file of s.openFiles) {
    if (file.worktreeId !== id) {
      continue
    }
    const owner = parseExecutionHostId(resolveEditorModelOwner(file, s).hostId)?.id
    if (owner) {
      sessionHosts.push(owner)
    }
  }
  for (const tab of s.unifiedTabsByWorktree[id] ?? []) {
    if (tab.executionHostId) {
      sessionHosts.push(tab.executionHostId)
    }
  }
  for (const browser of s.browserTabsByWorktree[id] ?? []) {
    for (const page of s.browserPagesByWorkspace[browser.id] ?? []) {
      if (page.browserRuntimeEnvironmentId === null) {
        if (isRuntimeHost(hostId) && publishers.every(isRuntimeHost)) {
          return true
        }
      } else if (page.browserRuntimeEnvironmentId) {
        sessionHosts.push(toRuntimeExecutionHostId(page.browserRuntimeEnvironmentId))
      }
    }
  }
  for (const tab of s.tabsByWorktree[id] ?? []) {
    const live = new Set([...(s.ptyIdsByTabId[tab.id] ?? []), ...(tab.ptyId ? [tab.ptyId] : [])])
    for (const ptyId of collectPtyIdsForTab(s, tab.id, tab.ptyId)) {
      const owner = getPtyExecutionHost(ptyId)
      if (owner === 'foreign') {
        return true
      }
      if (owner) {
        sessionHosts.push(owner)
      } else if (live.has(ptyId) && isRuntimeHost(hostId) && publishers.every(isRuntimeHost)) {
        return true
      }
    }
  }
  return sessionHosts.some((host) => host !== hostId && !publishers.includes(host))
}

// Extends #23249's host-scoped row split to owners known only by qualified session history.
export function planRepoCatalogOwnerRemoval(
  s: AppState,
  repos: readonly Repo[],
  hostId: ExecutionHostId
): RepoCatalogOwnerRemoval {
  const validRepoIds = new Set(
    repos.filter((repo) => getRepoExecutionHostId(repo) === hostId).map((repo) => repo.id)
  )
  const removed = new Set<string>()
  const aliases = new Map<string, HostWorktreeTarget>()
  const initialWorktreesByRepo = selectWorktreesByRepo(s)
  const initialDetectedWorktreesByRepo = selectDetectedWorktreesByRepo(s)
  let worktreesByRepo = initialWorktreesByRepo
  let detectedWorktreesByRepo = initialDetectedWorktreesByRepo
  const matchesRemovedOwner = (
    repoId: string,
    row: { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
  ): boolean => {
    if (validRepoIds.has(repoId)) {
      return false
    }
    if (!row.hostId && !row.runtimeOwnerEnvironmentId) {
      const owners = new Set(
        s.repos.filter((repo) => repo.id === repoId).map(getRepoExecutionHostId)
      )
      if (owners.size !== 1 || !owners.has(hostId)) {
        return false
      }
    }
    return worktreeMatchesHost(row, hostId, worktreeHostMatchOptions(s, repoId, hostId))
  }
  for (const [repoId, list] of Object.entries(initialWorktreesByRepo)) {
    const kept = list.filter((row) => {
      if (!matchesRemovedOwner(repoId, row)) {
        return true
      }
      removed.add(row.id)
      if (row.hostId) {
        aliases.set(
          `${row.hostId}|${row.id}`,
          hostWorktreeTarget({ id: row.id, hostId: row.hostId })
        )
      }
      return false
    })
    if (kept.length === list.length) {
      continue
    }
    if (worktreesByRepo === initialWorktreesByRepo) {
      worktreesByRepo = { ...worktreesByRepo }
    }
    if (kept.length > 0) {
      worktreesByRepo[repoId] = kept
    } else {
      delete worktreesByRepo[repoId]
    }
  }
  for (const [repoId, result] of Object.entries(initialDetectedWorktreesByRepo)) {
    const kept = result.worktrees.filter((row) => {
      if (!matchesRemovedOwner(repoId, row)) {
        return true
      }
      removed.add(row.id)
      if (row.hostId) {
        aliases.set(
          `${row.hostId}|${row.id}`,
          hostWorktreeTarget({ id: row.id, hostId: row.hostId })
        )
      }
      return false
    })
    if (kept.length === result.worktrees.length) {
      continue
    }
    if (detectedWorktreesByRepo === initialDetectedWorktreesByRepo) {
      detectedWorktreesByRepo = { ...detectedWorktreesByRepo }
    }
    if (kept.length > 0) {
      detectedWorktreesByRepo[repoId] = { ...result, worktrees: kept }
    } else {
      delete detectedWorktreesByRepo[repoId]
    }
  }
  const historyIds = new Set(removed)
  for (const key of Object.keys(s.lastVisitedAtByWorktreeId)) {
    const id = getWorktreeIdFromVisitKey(key)
    if (
      getExecutionHostIdFromWorktreeHostIdentity(key) === hostId &&
      isRepoWorkspace(id) &&
      !validRepoIds.has(getRepoIdFromWorktreeId(id))
    ) {
      historyIds.add(id)
    }
  }
  if (
    s.activeWorktreeId &&
    s.activeWorkspaceExecutionHostId === hostId &&
    isRepoWorkspace(s.activeWorktreeId) &&
    !validRepoIds.has(getRepoIdFromWorktreeId(s.activeWorktreeId))
  ) {
    historyIds.add(s.activeWorktreeId)
  }
  for (const [key, owner] of Object.entries(s.restoredRuntimeHostIdByWorkspaceSessionKey)) {
    const id = normalizeWorkspaceSessionKeyToWorkspaceId(key)
    if (owner === hostId && isRepoWorkspace(id) && !validRepoIds.has(getRepoIdFromWorktreeId(id))) {
      historyIds.add(id)
    }
  }
  const purgeTargets = [...historyIds]
    .filter((id) => !hasUnlistedSibling(s, id, hostId))
    .map((id) => hostWorktreeTarget({ id, hostId }))
  const survivingIds = new Set([
    ...Object.values(worktreesByRepo).flatMap((rows) => rows.map((row) => row.id)),
    ...Object.values(detectedWorktreesByRepo).flatMap((result) =>
      result.worktrees.map((row) => row.id)
    )
  ])
  return {
    rows: {
      worktreesByRepo,
      detectedWorktreesByRepo,
      sortEpoch:
        worktreesByRepo !== initialWorktreesByRepo ||
        detectedWorktreesByRepo !== initialDetectedWorktreesByRepo
          ? s.sortEpoch + 1
          : s.sortEpoch
    },
    purgeTargets,
    historyTargets: [
      ...[...historyIds].map((id) => hostWorktreeTarget({ id, hostId })),
      ...aliases.values()
    ],
    exclusiveIds: [...historyIds].filter(
      (id) => !survivingIds.has(id) && !hasUnlistedSibling(s, id, hostId)
    )
  }
}

export function removedRepoCatalogHistoryPatch(
  s: AppState,
  targets: readonly HostWorktreeTarget[]
): Partial<AppState> {
  const activeRemoved = targets.some(
    (target) =>
      target.id === s.activeWorktreeId && target.hostId === s.activeWorkspaceExecutionHostId
  )
  const removedOwners = new Set(targets.map((target) => `${target.hostId}|${target.id}`))
  let restoredOwners = s.restoredRuntimeHostIdByWorkspaceSessionKey
  for (const [key, hostId] of Object.entries(restoredOwners)) {
    if (!removedOwners.has(`${hostId}|${normalizeWorkspaceSessionKeyToWorkspaceId(key)}`)) {
      continue
    }
    if (restoredOwners === s.restoredRuntimeHostIdByWorkspaceSessionKey) {
      restoredOwners = { ...restoredOwners }
    }
    delete restoredOwners[key]
  }
  return {
    restoredRuntimeHostIdByWorkspaceSessionKey: restoredOwners,
    lastVisitedAtByWorktreeId: removeWorktreeVisitEntriesForTargets(
      s.lastVisitedAtByWorktreeId,
      targets
    ),
    ...(activeRemoved
      ? {
          activeWorktreeId: null,
          activeWorkspaceExecutionHostId: null,
          ...(s.activeWorkspaceKey === s.activeWorktreeId ||
          s.activeWorkspaceKey === worktreeWorkspaceKey(s.activeWorktreeId ?? '')
            ? { activeWorkspaceKey: null }
            : {})
        }
      : {})
  }
}
