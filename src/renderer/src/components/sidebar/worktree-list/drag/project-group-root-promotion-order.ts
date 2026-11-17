import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  compareRootProjectEntries,
  getRootProjectEntryRank,
  type RootProjectEntry
} from '../../../../../../shared/sidebar-list/sections/root-project-order'
import {
  collectTargetProjectGroupSiblingIds,
  getCatalogHostIdForExecutionHost
} from './group-header-hit-geometry'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import { ROOT_INTERLEAVED_GROUP_BUCKET_KEY } from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDragBucketKey } from './project-group-header-drop'
import type { ProjectGroupHeaderDropTarget } from './project-group-header-reparent-drop'
import { invokeBoolCallback } from './project-group-header-drag-rollback'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

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
  const draggedOwnerHostId = getRepoExecutionHostId(args.draggedGroup)
  const draggedCatalogHostId = getCatalogHostIdForExecutionHost(draggedOwnerHostId)
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
      !isRepoHeaderIdPinned(
        repo.id,
        args.pinnedRepoHeaderIds,
        anyRepoById,
        draggedOwnerHostId,
        args.repos
      ) &&
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
    respaceKeys = interleavedKeys
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

  const makePlacement = (
    order: number | null | undefined,
    needsRespace: boolean
  ): RootPromotionPlacement => ({
    groupInsertIndex,
    rootOrderPatch: order === undefined ? {} : { rootProjectOrder: order },
    interleavedDropIndex,
    ...(needsRespace ? { respaceKeys } : {}),
    needsInterleavedRespace: needsRespace
  })

  if (prevRank !== undefined && Number.isFinite(prevRank)) {
    if (nextRank !== undefined && Number.isFinite(nextRank)) {
      if (nextRank > prevRank) {
        const midpoint = (prevRank + nextRank) / 2
        if (Number.isFinite(midpoint) && midpoint > prevRank && midpoint < nextRank) {
          return { ...makePlacement(midpoint, false), respaceKeys }
        }
      }
      return makePlacement(prevRank, true)
    }
    const afterCandidate = Math.max(prevRank + 1000, args.nextRootProjectOrder ?? prevRank + 1000)
    return Number.isFinite(afterCandidate) && afterCandidate > prevRank
      ? makePlacement(afterCandidate, false)
      : makePlacement(prevRank, true)
  }

  if (
    prevEntry === undefined &&
    nextRank !== undefined &&
    Number.isFinite(nextRank) &&
    entries.some((entry) => entry.kind === 'group' && entry.group.rootProjectOrder !== undefined)
  ) {
    const beforeCandidate = nextRank - 1000
    return Number.isFinite(beforeCandidate) && beforeCandidate < nextRank
      ? makePlacement(beforeCandidate, false)
      : makePlacement(nextRank, true)
  }

  return makePlacement(args.draggedGroup.rootProjectOrder !== undefined ? null : undefined, false)
}

export function buildSyntheticRootRespaceDrop(
  baseKeys: readonly string[],
  draggedKey: string,
  dropIndex: number
): { visibleKeys: string[]; dropIndex: number } | null {
  const otherKeys = baseKeys.filter((key) => key !== draggedKey)
  if (otherKeys.length === 0) {
    return null
  }
  if (dropIndex < otherKeys.length) {
    return { visibleKeys: [...otherKeys, draggedKey], dropIndex }
  }
  return { visibleKeys: [draggedKey, ...otherKeys], dropIndex: otherKeys.length + 1 }
}

function resolvePromotedRootOrderRespaceDrop(args: {
  draggedGroup: ProjectGroup
  existingSiblingIds: readonly string[]
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  rootProjectHeaderKeys?: readonly string[]
  nextRootProjectOrder?: number
}): { visibleKeys: string[]; dropIndex: number; draggedKey: string } | null {
  if (
    args.dropTarget.kind !== 'slot' ||
    (args.dropTarget.targetBucketKey !== ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
      args.dropTarget.targetBucketKey !== 'root')
  ) {
    return null
  }
  const existingUnpinnedSiblingIds = args.existingSiblingIds.filter(
    (groupId) => args.projectGroupById.get(groupId)?.isPinned !== true
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
    !placement.needsInterleavedRespace ||
    placement.interleavedDropIndex === undefined ||
    !baseKeys
  ) {
    return null
  }
  const draggedKey = `group:${args.draggedGroup.id}`
  const respaceDrop = buildSyntheticRootRespaceDrop(
    baseKeys,
    draggedKey,
    placement.interleavedDropIndex
  )
  return respaceDrop ? { ...respaceDrop, draggedKey } : null
}

export async function maybeRespacePromotedRootOrder(args: {
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
  onCommitRootProjectOrder?: RootProjectHeaderDrag['onCommitRootProjectOrder']
}): Promise<boolean> {
  const existingSiblingIds = collectTargetProjectGroupSiblingIds({
    draggedGroupId: args.draggedGroup.id,
    targetParentGroupId: null,
    ownerHostId: getRepoExecutionHostId(args.draggedGroup),
    seededSiblingIds: args.sidebarProjectGroupHeaderIdsByBucket.get('root') ?? [],
    projectGroupById: args.projectGroupById
  })
  const respaceDrop = resolvePromotedRootOrderRespaceDrop({
    draggedGroup: args.draggedGroup,
    existingSiblingIds,
    dropTarget: args.dropTarget,
    projectGroupById: args.projectGroupById,
    repos: args.repos,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    rootProjectHeaderKeys: args.rootProjectHeaderKeys,
    nextRootProjectOrder: args.nextRootProjectOrder
  })
  if (!respaceDrop) {
    return true
  }
  const commitRootOrder = args.onCommitRootProjectOrder
  if (!commitRootOrder) {
    return false
  }
  return invokeBoolCallback(() =>
    args.rootProjectHeaderHostId !== undefined
      ? commitRootOrder(
          respaceDrop.visibleKeys,
          respaceDrop.draggedKey,
          respaceDrop.dropIndex,
          args.rootProjectHeaderHostId
        )
      : commitRootOrder(respaceDrop.visibleKeys, respaceDrop.draggedKey, respaceDrop.dropIndex)
  )
}
