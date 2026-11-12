import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getNextRootProjectOrder,
  getRootProjectEntryRank,
  type RootProjectEntry
} from '../../../../../../shared/root-project-order'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'

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
  const draggedCatalogHostId = getCatalogHostIdForExecutionHost(
    getRepoExecutionHostId(args.draggedRepo)
  )
  const matchesHost = (hostId: ReturnType<typeof getRepoExecutionHostId>): boolean =>
    !draggedCatalogHostId || getCatalogHostIdForExecutionHost(hostId) === draggedCatalogHostId
  const hostRepos = args.liveRepos.filter((repo) => matchesHost(getRepoExecutionHostId(repo)))
  const hostGroups = (args.projectGroups ?? [...(args.projectGroupById?.values() ?? [])]).filter(
    (group) => matchesHost(getRepoExecutionHostId(group))
  )
  const hostRepoById = new Map(hostRepos.map((repo) => [repo.id, repo]))
  const interleavedKeys = args.rootProjectHeaderKeys.filter(
    (key) => key !== `repo:${args.draggedRepo.id}`
  )
  const clampedDropIndex = Math.max(0, Math.min(interleavedKeys.length, args.dropIndex))
  const interleavedKeysWithRepo = [...interleavedKeys]
  interleavedKeysWithRepo.splice(clampedDropIndex, 0, `repo:${args.draggedRepo.id}`)

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
      const repo = hostRepoById.get(repoId) ?? args.repoById.get(repoId)
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
        return {
          order: (prevRank + nextRank) / 2,
          interleavedKeysWithRepo,
          clampedDropIndex,
          needsInterleavedRespace: false
        }
      }
      return {
        order: prevRank,
        interleavedKeysWithRepo,
        clampedDropIndex,
        needsInterleavedRespace: true
      }
    }
    return {
      order: Math.max(prevRank + 1000, nextRootProjectOrder ?? prevRank + 1000),
      interleavedKeysWithRepo,
      clampedDropIndex,
      needsInterleavedRespace: false
    }
  }

  if (nextEntry !== undefined) {
    if (nextRank !== undefined && Number.isFinite(nextRank)) {
      return {
        order: nextRank - 1000,
        interleavedKeysWithRepo,
        clampedDropIndex,
        needsInterleavedRespace: false
      }
    }
    return {
      order: 0,
      interleavedKeysWithRepo,
      clampedDropIndex,
      needsInterleavedRespace: true
    }
  }

  return {
    order: nextRootProjectOrder ?? 0,
    interleavedKeysWithRepo,
    clampedDropIndex,
    needsInterleavedRespace: false
  }
}
