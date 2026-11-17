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
import type { ProjectGroupHeaderDragBucketKey } from './project-group-header-drop'
import { ROOT_INTERLEAVED_GROUP_BUCKET_KEY } from './project-group-header-drag-contract'
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
    respaceKeys = interleavedKeys
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
        const midpoint = (prevRank + nextRank) / 2
        if (Number.isFinite(midpoint) && midpoint > prevRank && midpoint < nextRank) {
          return {
            groupInsertIndex,
            rootOrderPatch: { rootProjectOrder: midpoint },
            interleavedDropIndex,
            respaceKeys,
            needsInterleavedRespace: false
          }
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
    const afterCandidate = Math.max(prevRank + 1000, args.nextRootProjectOrder ?? prevRank + 1000)
    if (Number.isFinite(afterCandidate) && afterCandidate > prevRank) {
      return {
        groupInsertIndex,
        rootOrderPatch: { rootProjectOrder: afterCandidate },
        interleavedDropIndex,
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

  if (
    prevEntry === undefined &&
    nextRank !== undefined &&
    Number.isFinite(nextRank) &&
    entries.some((entry) => entry.kind === 'group' && entry.group.rootProjectOrder !== undefined)
  ) {
    const beforeCandidate = nextRank - 1000
    if (Number.isFinite(beforeCandidate) && beforeCandidate < nextRank) {
      return {
        groupInsertIndex,
        rootOrderPatch: { rootProjectOrder: beforeCandidate },
        interleavedDropIndex,
        needsInterleavedRespace: false
      }
    }
    return {
      groupInsertIndex,
      rootOrderPatch: { rootProjectOrder: nextRank },
      interleavedDropIndex,
      respaceKeys,
      needsInterleavedRespace: true
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

export function resolvePromotedRootOrderRespaceDrop(args: {
  draggedGroup: ProjectGroup
  existingSiblingIds: readonly string[]
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  rootProjectHeaderKeys?: readonly string[]
  nextRootProjectOrder?: number
}): { visibleKeys: string[]; draggedKey: string; dropIndex: number } | null {
  if (
    args.dropTarget.kind !== 'slot' ||
    (args.dropTarget.targetBucketKey !== ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
      args.dropTarget.targetBucketKey !== 'root')
  ) {
    return null
  }
  const placement = resolveRootPromotionPlacement(args)
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
  rootProjectHeaderKeys?: readonly string[]
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
    commitRootOrder(respaceDrop.visibleKeys, respaceDrop.draggedKey, respaceDrop.dropIndex)
  )
}
