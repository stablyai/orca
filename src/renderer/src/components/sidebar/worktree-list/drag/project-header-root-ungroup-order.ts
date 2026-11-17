import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  getNextRootProjectOrder,
  getRootProjectEntryRank,
  type RootProjectEntry
} from '../../../../../../shared/sidebar-list/sections/root-project-order'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { buildSyntheticRootRespaceDrop } from './project-group-root-promotion-order'

export function resolveSiblingRepoForDraggedHost(
  repoId: string,
  draggedHostId: ExecutionHostId | undefined,
  liveRepos: readonly Repo[],
  repoById: ReadonlyMap<string, Repo>
): Repo | undefined {
  const exactLive = liveRepos.find(
    (candidate) => candidate.id === repoId && getRepoExecutionHostId(candidate) === draggedHostId
  )
  if (exactLive) {
    return exactLive
  }
  const draggedCatalogHostId = getCatalogHostIdForExecutionHost(draggedHostId)
  if (draggedCatalogHostId) {
    const catalogLive = liveRepos.find(
      (candidate) =>
        candidate.id === repoId &&
        getCatalogHostIdForExecutionHost(getRepoExecutionHostId(candidate)) === draggedCatalogHostId
    )
    if (catalogLive) {
      return catalogLive
    }
  }
  const fallback = repoById.get(repoId)
  if (!fallback) {
    return undefined
  }
  const fallbackHostId = getRepoExecutionHostId(fallback)
  if (
    fallbackHostId === draggedHostId ||
    (draggedCatalogHostId &&
      getCatalogHostIdForExecutionHost(fallbackHostId) === draggedCatalogHostId)
  ) {
    return fallback
  }
  return undefined
}

export function resolveUngroupedRepoInterleavedRootPlacement(args: {
  draggedRepo: Repo
  dropIndex: number
  rootProjectHeaderKeys: readonly string[]
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  projectGroups?: readonly ProjectGroup[]
  liveRepos: readonly Repo[]
  repoById: ReadonlyMap<string, Repo>
  orderedRepoIds: readonly string[]
}): {
  order: number
  interleavedKeysWithRepo: string[]
  clampedDropIndex: number
  needsInterleavedRespace: boolean
} {
  const draggedHostId = getRepoExecutionHostId(args.draggedRepo)
  const draggedCatalogHostId = getCatalogHostIdForExecutionHost(draggedHostId)
  const matchesHost = (hostId: ExecutionHostId): boolean =>
    !draggedCatalogHostId || getCatalogHostIdForExecutionHost(hostId) === draggedCatalogHostId
  const hostRepoById = new Map<string, Repo>()
  for (const candidate of args.liveRepos) {
    if (!matchesHost(getRepoExecutionHostId(candidate))) {
      continue
    }
    const resolved = resolveSiblingRepoForDraggedHost(
      candidate.id,
      draggedHostId,
      args.liveRepos,
      args.repoById
    )
    if (resolved) {
      hostRepoById.set(candidate.id, resolved)
    }
  }
  const hostRepos = [...hostRepoById.values()]
  const hostGroups = (args.projectGroups ?? [...(args.projectGroupById?.values() ?? [])]).filter(
    (group) => matchesHost(getRepoExecutionHostId(group))
  )
  const draggedKey = `repo:${args.draggedRepo.id}`
  const interleavedKeys = args.rootProjectHeaderKeys.filter((key) => key !== draggedKey)
  const clampedDropIndex = Math.max(0, Math.min(interleavedKeys.length, args.dropIndex))
  const respaceDrop = buildSyntheticRootRespaceDrop(interleavedKeys, draggedKey, clampedDropIndex)
  const interleavedKeysWithRepo = respaceDrop?.visibleKeys ?? [...interleavedKeys, draggedKey]
  const respaceDropIndex = respaceDrop?.dropIndex ?? clampedDropIndex

  const entries: RootProjectEntry[] = []
  let rootInsertIndex = 0
  for (const [keyIndex, key] of interleavedKeys.entries()) {
    if (keyIndex === clampedDropIndex) {
      rootInsertIndex = entries.length
    }
    if (key.startsWith('group:')) {
      const group = args.projectGroupById?.get(key.slice('group:'.length))
      if (group) {
        entries.push({ kind: 'group', group })
      }
    } else if (key.startsWith('repo:')) {
      const repoId = key.slice('repo:'.length)
      const repo =
        hostRepoById.get(repoId) ??
        resolveSiblingRepoForDraggedHost(repoId, draggedHostId, args.liveRepos, args.repoById)
      if (repo) {
        entries.push({ kind: 'repo', repo })
      }
    }
  }
  if (clampedDropIndex >= interleavedKeys.length) {
    rootInsertIndex = entries.length
  }

  const repoOrder = getLogicalRepoOrderRankById(args.orderedRepoIds)
  const prevEntry = rootInsertIndex > 0 ? entries[rootInsertIndex - 1] : undefined
  const nextEntry = rootInsertIndex < entries.length ? entries[rootInsertIndex] : undefined
  const prevRank = prevEntry ? getRootProjectEntryRank(prevEntry, repoOrder) : undefined
  const nextRank = nextEntry ? getRootProjectEntryRank(nextEntry, repoOrder) : undefined
  const nextRootProjectOrder = getNextRootProjectOrder(hostRepos, hostGroups)

  if (prevRank !== undefined && Number.isFinite(prevRank)) {
    if (nextEntry !== undefined) {
      if (nextRank !== undefined && Number.isFinite(nextRank) && nextRank > prevRank) {
        const midpoint = (prevRank + nextRank) / 2
        if (Number.isFinite(midpoint) && midpoint > prevRank && midpoint < nextRank) {
          return {
            order: midpoint,
            interleavedKeysWithRepo,
            clampedDropIndex: respaceDropIndex,
            needsInterleavedRespace: false
          }
        }
      }
      return {
        order: prevRank,
        interleavedKeysWithRepo,
        clampedDropIndex: respaceDropIndex,
        needsInterleavedRespace: Boolean(respaceDrop)
      }
    }
    const afterCandidate = Math.max(prevRank + 1000, nextRootProjectOrder ?? prevRank + 1000)
    if (Number.isFinite(afterCandidate) && afterCandidate > prevRank) {
      return {
        order: afterCandidate,
        interleavedKeysWithRepo,
        clampedDropIndex: respaceDropIndex,
        needsInterleavedRespace: false
      }
    }
    return {
      order: prevRank,
      interleavedKeysWithRepo,
      clampedDropIndex: respaceDropIndex,
      needsInterleavedRespace: Boolean(respaceDrop)
    }
  }

  if (nextEntry !== undefined) {
    if (nextRank !== undefined && Number.isFinite(nextRank)) {
      const beforeCandidate = nextRank - 1000
      if (Number.isFinite(beforeCandidate) && beforeCandidate < nextRank) {
        return {
          order: beforeCandidate,
          interleavedKeysWithRepo,
          clampedDropIndex: respaceDropIndex,
          needsInterleavedRespace: false
        }
      }
      return {
        order: nextRank,
        interleavedKeysWithRepo,
        clampedDropIndex: respaceDropIndex,
        needsInterleavedRespace: Boolean(respaceDrop)
      }
    }
    return {
      order: 0,
      interleavedKeysWithRepo,
      clampedDropIndex: respaceDropIndex,
      needsInterleavedRespace: Boolean(respaceDrop)
    }
  }

  const fallbackOrder = nextRootProjectOrder ?? 0
  return {
    order: Number.isFinite(fallbackOrder) ? fallbackOrder : 0,
    interleavedKeysWithRepo,
    clampedDropIndex: respaceDropIndex,
    needsInterleavedRespace: false
  }
}
