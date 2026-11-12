import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  compareRootProjectEntries,
  getRootProjectEntryRank,
  type RootProjectEntry
} from '../../../../../../shared/root-project-order'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { ROOT_INTERLEAVED_GROUP_BUCKET_KEY } from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDropTarget } from './project-group-header-reparent-drop'

export type RootPromotionPlacement = {
  groupInsertIndex: number
  rootOrderPatch: { rootProjectOrder?: number | null }
  interleavedDropIndex?: number
  respaceKeys?: readonly string[]
  needsInterleavedRespace: boolean
}

export function resolveRootPromotionPlacement(args: {
  draggedGroup: ProjectGroup
  existingSiblingIds: readonly string[]
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  rootProjectHeaderKeys?: readonly string[]
  nextRootProjectOrder?: number
}): RootPromotionPlacement {
  const draggedCatalogHostId = getCatalogHostIdForExecutionHost(
    getRepoExecutionHostId(args.draggedGroup)
  )
  const repoOrder = getLogicalRepoOrderRankById((args.repos ?? []).map((repo) => repo.id))
  const anyRepoById = new Map<string, Repo>()
  const sameHostUngroupedRepoById = new Map<string, Repo>()
  for (const repo of args.repos ?? []) {
    anyRepoById.set(repo.id, repo)
    if (
      getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo)) === draggedCatalogHostId &&
      (!repo.projectGroupId || !args.projectGroupById.has(repo.projectGroupId))
    ) {
      sameHostUngroupedRepoById.set(repo.id, repo)
    }
  }

  let entries: RootProjectEntry[] = []
  let rootInsertIndex = 0
  let groupInsertIndex = 0
  let interleavedDropIndex: number | undefined
  let respaceKeys: readonly string[] | undefined

  if (
    args.dropTarget.kind === 'slot' &&
    args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
    args.rootProjectHeaderKeys
  ) {
    const interleavedKeys = args.rootProjectHeaderKeys.filter(
      (key) => key !== `group:${args.draggedGroup.id}`
    )
    const clampedDropIndex = Math.max(
      0,
      Math.min(interleavedKeys.length, args.dropTarget.dropIndex)
    )
    interleavedDropIndex = clampedDropIndex
    const siblingSet = new Set(args.existingSiblingIds)
    for (const [keyIndex, key] of interleavedKeys.entries()) {
      if (keyIndex === clampedDropIndex) {
        rootInsertIndex = entries.length
      }
      if (key.startsWith('group:')) {
        const groupId = key.slice('group:'.length)
        if (keyIndex < clampedDropIndex && siblingSet.has(groupId)) {
          groupInsertIndex += 1
        }
        const group = args.projectGroupById.get(groupId)
        if (group) {
          entries.push({ kind: 'group', group })
        }
      } else if (key.startsWith('repo:')) {
        const repoId = key.slice('repo:'.length)
        const repo = sameHostUngroupedRepoById.get(repoId) ?? anyRepoById.get(repoId)
        if (repo) {
          entries.push({ kind: 'repo', repo })
        }
      }
    }
    if (clampedDropIndex >= interleavedKeys.length) {
      rootInsertIndex = entries.length
    }
  } else {
    groupInsertIndex =
      args.dropTarget.kind === 'group-header'
        ? args.existingSiblingIds.length
        : Math.max(0, Math.min(args.existingSiblingIds.length, args.dropTarget.dropIndex))
    entries = [
      ...args.existingSiblingIds
        .map((id) => args.projectGroupById.get(id))
        .filter((group): group is ProjectGroup => group !== undefined)
        .map((group): RootProjectEntry => ({ kind: 'group', group })),
      ...[...sameHostUngroupedRepoById.values()].map((repo): RootProjectEntry => ({
        kind: 'repo',
        repo
      }))
    ].sort((left, right) => compareRootProjectEntries(left, right, repoOrder))
    if (groupInsertIndex > 0) {
      const prevSiblingId = args.existingSiblingIds[groupInsertIndex - 1]
      const prevIdx = entries.findIndex(
        (entry) => entry.kind === 'group' && entry.group.id === prevSiblingId
      )
      rootInsertIndex = prevIdx !== -1 ? prevIdx + 1 : entries.length
    }
    interleavedDropIndex = rootInsertIndex
    respaceKeys = entries.map((entry) =>
      entry.kind === 'group' ? `group:${entry.group.id}` : `repo:${entry.repo.id}`
    )
  }

  const prevEntry = rootInsertIndex > 0 ? entries[rootInsertIndex - 1] : undefined
  const nextEntry = rootInsertIndex < entries.length ? entries[rootInsertIndex] : undefined
  const prevRank = prevEntry ? getRootProjectEntryRank(prevEntry, repoOrder) : undefined
  const nextRank = nextEntry ? getRootProjectEntryRank(nextEntry, repoOrder) : undefined

  if (prevRank !== undefined && Number.isFinite(prevRank)) {
    if (nextRank !== undefined && Number.isFinite(nextRank)) {
      if (nextRank > prevRank) {
        return {
          groupInsertIndex,
          rootOrderPatch: { rootProjectOrder: (prevRank + nextRank) / 2 },
          interleavedDropIndex,
          respaceKeys,
          needsInterleavedRespace: false
        }
      }
      return {
        groupInsertIndex,
        rootOrderPatch: { rootProjectOrder: prevRank },
        interleavedDropIndex,
        respaceKeys,
        needsInterleavedRespace: true
      }
    }
    return {
      groupInsertIndex,
      rootOrderPatch: {
        rootProjectOrder: Math.max(prevRank + 1000, args.nextRootProjectOrder ?? prevRank + 1000)
      },
      interleavedDropIndex,
      needsInterleavedRespace: false
    }
  }

  if (
    prevEntry === undefined &&
    nextRank !== undefined &&
    Number.isFinite(nextRank) &&
    entries.some((entry) => entry.kind === 'group' && entry.group.rootProjectOrder !== undefined)
  ) {
    return {
      groupInsertIndex,
      rootOrderPatch: { rootProjectOrder: nextRank - 1000 },
      interleavedDropIndex,
      needsInterleavedRespace: false
    }
  }

  return {
    groupInsertIndex,
    rootOrderPatch:
      args.draggedGroup.rootProjectOrder !== undefined ? { rootProjectOrder: null } : {},
    interleavedDropIndex,
    needsInterleavedRespace: false
  }
}
