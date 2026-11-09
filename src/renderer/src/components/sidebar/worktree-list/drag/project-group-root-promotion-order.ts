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
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import { ROOT_INTERLEAVED_GROUP_BUCKET_KEY } from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDragBucketKey } from './project-group-header-drop'
import {
  filterProjectGroupIdsByCatalogHost,
  type ProjectGroupHeaderDropTarget
} from './project-group-header-reparent-drop'

export type RootPromotionPlacement = {
  groupInsertIndex: number
  rootOrderPatch: { rootProjectOrder?: number | null }
  interleavedDropIndex?: number
  respaceKeys?: readonly string[]
  needsInterleavedRespace: boolean
}

export function resolveRootPromotionPlacement(args: {
  draggedGroup: ProjectGroup
  existingUnpinnedSiblingIds: readonly string[]
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  rootProjectHeaderKeys?: readonly string[]
  nextRootProjectOrder?: number
}): RootPromotionPlacement {
  const draggedCatalogHostId = getCatalogHostIdForExecutionHost(
    getRepoExecutionHostId(args.draggedGroup)
  )
  const repoOrder = getLogicalRepoOrderRankById((args.repos ?? []).map((repo) => repo.id))
  const anyRepoById = new Map<string, Repo>()
  const sameHostUnpinnedUngroupedRepoById = new Map<string, Repo>()
  for (const repo of args.repos ?? []) {
    anyRepoById.set(repo.id, repo)
  }
  for (const repo of args.repos ?? []) {
    if (
      getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo)) === draggedCatalogHostId &&
      (!repo.projectGroupId || !args.projectGroupById.has(repo.projectGroupId)) &&
      !isRepoHeaderIdPinned(repo.id, args.pinnedRepoHeaderIds, anyRepoById) &&
      repo.isPinned !== true
    ) {
      sameHostUnpinnedUngroupedRepoById.set(repo.id, repo)
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
    const siblingSet = new Set(args.existingUnpinnedSiblingIds)
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
        const repo = sameHostUnpinnedUngroupedRepoById.get(repoId) ?? anyRepoById.get(repoId)
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
        ? args.existingUnpinnedSiblingIds.length
        : Math.max(0, Math.min(args.existingUnpinnedSiblingIds.length, args.dropTarget.dropIndex))
    entries = [
      ...args.existingUnpinnedSiblingIds
        .map((id) => args.projectGroupById.get(id))
        .filter((group): group is ProjectGroup => group !== undefined)
        .map((group): RootProjectEntry => ({ kind: 'group', group })),
      ...[...sameHostUnpinnedUngroupedRepoById.values()].map((repo): RootProjectEntry => ({
        kind: 'repo',
        repo
      }))
    ].sort((left, right) => compareRootProjectEntries(left, right, repoOrder))
    if (groupInsertIndex > 0) {
      const prevSiblingId = args.existingUnpinnedSiblingIds[groupInsertIndex - 1]
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

export function maybeRespacePromotedRootOrder(args: {
  draggedGroup: ProjectGroup
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  rootProjectHeaderKeys?: readonly string[]
  rootProjectHeaderHostId?: string
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  nextRootProjectOrder?: number
  onCommitRootProjectOrder?: (
    keys: readonly string[],
    draggedKey: string,
    sidebarDropIndex: number,
    hostId?: string
  ) => void
}): void {
  if (
    args.dropTarget.kind !== 'slot' ||
    (args.dropTarget.targetBucketKey !== ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
      args.dropTarget.targetBucketKey !== 'root') ||
    !args.onCommitRootProjectOrder
  ) {
    return
  }
  const existingUnpinnedSiblingIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get('root') ?? [],
    getRepoExecutionHostId(args.draggedGroup),
    args.projectGroupById
  ).filter(
    (groupId) =>
      groupId !== args.draggedGroup.id && args.projectGroupById.get(groupId)?.isPinned !== true
  )
  const placement = resolveRootPromotionPlacement({
    draggedGroup: args.draggedGroup,
    existingUnpinnedSiblingIds,
    dropTarget: args.dropTarget,
    projectGroupById: args.projectGroupById,
    repos: args.repos,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    rootProjectHeaderKeys: args.rootProjectHeaderKeys,
    nextRootProjectOrder: args.nextRootProjectOrder
  })
  const baseKeys =
    args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
    args.rootProjectHeaderKeys
      ? args.rootProjectHeaderKeys
      : placement.respaceKeys
  if (
    placement.needsInterleavedRespace &&
    placement.interleavedDropIndex !== undefined &&
    baseKeys
  ) {
    const interleavedKeys = baseKeys.filter((key) => key !== `group:${args.draggedGroup.id}`)
    interleavedKeys.splice(placement.interleavedDropIndex, 0, `group:${args.draggedGroup.id}`)
    if (args.rootProjectHeaderHostId !== undefined) {
      args.onCommitRootProjectOrder(
        interleavedKeys,
        `group:${args.draggedGroup.id}`,
        placement.interleavedDropIndex,
        args.rootProjectHeaderHostId
      )
    } else {
      args.onCommitRootProjectOrder(
        interleavedKeys,
        `group:${args.draggedGroup.id}`,
        placement.interleavedDropIndex
      )
    }
  }
}
