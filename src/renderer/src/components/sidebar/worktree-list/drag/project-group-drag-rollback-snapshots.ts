import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import {
  isProjectGroupStillInExpectedParent,
  isRepoStillInExpectedProjectGroup
} from './group-header-hit-geometry'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'

export function getRepoSnapshotKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo) ?? 'local'}::${repo.id}`
}

export function buildProjectGroupRollbackPatch(
  group: ProjectGroup | undefined,
  updates: ProjectGroupHeaderUpdatePatch
): ProjectGroupHeaderUpdatePatch | null {
  if (!group) {
    return null
  }
  const patch: ProjectGroupHeaderUpdatePatch = {}
  if (updates.parentGroupId !== undefined) {
    patch.parentGroupId = group.parentGroupId ?? null
    patch.rootProjectOrder = group.rootProjectOrder ?? null
    if (group.isPinned === true) {
      patch.isPinned = true
    }
  }
  if (updates.tabOrder !== undefined) {
    patch.tabOrder = group.tabOrder
  }
  if (updates.rootProjectOrder !== undefined) {
    patch.rootProjectOrder = group.rootProjectOrder ?? null
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function captureGroupRollback(args: {
  groupId: string
  updates: ProjectGroupHeaderUpdatePatch
  ownerHostId: ExecutionHostId | null | undefined
  liveProjectGroups: readonly ProjectGroup[] | undefined
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
}): { patch: ProjectGroupHeaderUpdatePatch | null; previousIsPinned: boolean } {
  const preDropGroup =
    args.liveProjectGroups?.find(
      (candidate) =>
        candidate.id === args.groupId &&
        (!args.ownerHostId || getRepoExecutionHostId(candidate) === args.ownerHostId)
    ) ?? args.fallbackProjectGroupById.get(args.groupId)
  return {
    patch: buildProjectGroupRollbackPatch(preDropGroup, args.updates),
    previousIsPinned: preDropGroup?.isPinned === true
  }
}

export function captureRepoRollback(args: {
  repo: Repo
  liveRepos: readonly Repo[] | undefined
  fallbackRepoById: ReadonlyMap<string, Repo> | undefined
}): {
  repo: Repo
  previousProjectGroupId: string | null
  previousOrder: number | null
  previousIsPinned: boolean
} {
  const fallback = args.fallbackRepoById?.get(args.repo.id)
  const preDropRepo =
    args.liveRepos?.find((candidate) => isSameRepoRow(candidate, args.repo)) ??
    (fallback && isSameRepoRow(fallback, args.repo) ? fallback : args.repo)
  return {
    repo: preDropRepo,
    previousProjectGroupId: preDropRepo.projectGroupId ?? null,
    previousOrder: preDropRepo.projectGroupOrder ?? null,
    previousIsPinned: preDropRepo.isPinned === true
  }
}

export type PrimaryRepoFailureResolution =
  | {
      kind: 'rollback'
      expectedLiveProjectGroupId: string | null
      expectedLiveOrder: number | null
      expectedLiveIsPinned: boolean
    }
  | { kind: 'reconcile' }
  | { kind: 'none' }

export function resolvePartialPrimaryRepoSnapshot(args: {
  mutation: { repo: Repo; projectGroupId: string | null; order: number }
  capturedRepo: {
    previousProjectGroupId: string | null
    previousOrder: number | null
    previousIsPinned: boolean
  }
  liveRepos: readonly Repo[] | undefined
}): PrimaryRepoFailureResolution {
  const liveRepo = args.liveRepos?.find((candidate) => isSameRepoRow(candidate, args.mutation.repo))
  if (!liveRepo) {
    return { kind: 'none' }
  }
  const liveGroupId = liveRepo.projectGroupId ?? null
  const liveOrder = liveRepo.projectGroupOrder ?? null
  const livePinned = liveRepo.isPinned === true
  const changed =
    liveGroupId !== args.capturedRepo.previousProjectGroupId ||
    liveOrder !== args.capturedRepo.previousOrder ||
    livePinned !== args.capturedRepo.previousIsPinned
  if (!changed) {
    return { kind: 'none' }
  }
  if (
    (liveGroupId === args.mutation.projectGroupId ||
      liveGroupId === args.capturedRepo.previousProjectGroupId) &&
    liveOrder === args.mutation.order
  ) {
    return {
      kind: 'rollback',
      expectedLiveProjectGroupId: liveGroupId,
      expectedLiveOrder: liveOrder,
      expectedLiveIsPinned: livePinned
    }
  }
  if (
    args.mutation.projectGroupId !== null &&
    liveGroupId === null &&
    liveOrder === args.mutation.order
  ) {
    return { kind: 'reconcile' }
  }
  return { kind: 'none' }
}

export function isGroupRollbackEntryStillLive(args: {
  groupId: string
  expectedLiveParentGroupId: string | null
  expectedLiveTabOrder?: number
  expectedLiveRootProjectOrder?: number | null
  expectedLiveIsPinned?: boolean
  hasExpectedLiveRootProjectOrder: boolean
  hasExpectedLiveIsPinned: boolean
  ownerHostId: ExecutionHostId | null | undefined
  liveProjectGroups: readonly ProjectGroup[]
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
}): boolean {
  if (
    !isProjectGroupStillInExpectedParent({
      groupId: args.groupId,
      expectedParentGroupId: args.expectedLiveParentGroupId,
      ownerHostId: args.ownerHostId,
      liveProjectGroups: args.liveProjectGroups,
      fallbackProjectGroupById: args.fallbackProjectGroupById
    })
  ) {
    return false
  }
  const liveGroup = args.liveProjectGroups.find(
    (candidate) =>
      candidate.id === args.groupId &&
      (!args.ownerHostId || getRepoExecutionHostId(candidate) === args.ownerHostId)
  )
  return Boolean(
    liveGroup &&
    (args.expectedLiveTabOrder === undefined || liveGroup.tabOrder === args.expectedLiveTabOrder) &&
    (!args.hasExpectedLiveRootProjectOrder ||
      (liveGroup.rootProjectOrder ?? null) === args.expectedLiveRootProjectOrder) &&
    (!args.hasExpectedLiveIsPinned || (liveGroup.isPinned === true) === args.expectedLiveIsPinned)
  )
}

export function isRepoRollbackEntryStillLive(args: {
  repo: Repo
  expectedLiveProjectGroupId: string | null
  expectedLiveOrder: number | null
  expectedLiveIsPinned?: boolean
  hasExpectedLiveIsPinned: boolean
  liveRepos: readonly Repo[]
  fallbackRepoById: ReadonlyMap<string, Repo> | undefined
}): { stillLive: boolean; livePinned: boolean } {
  if (
    !isRepoStillInExpectedProjectGroup({
      repo: args.repo,
      expectedProjectGroupId: args.expectedLiveProjectGroupId,
      liveRepos: args.liveRepos,
      fallbackRepoById: args.fallbackRepoById
    })
  ) {
    return { stillLive: false, livePinned: false }
  }
  const liveRepo = args.liveRepos.find((candidate) => isSameRepoRow(candidate, args.repo))
  const stillLive = Boolean(
    liveRepo &&
    (liveRepo.projectGroupOrder ?? null) === args.expectedLiveOrder &&
    (!args.hasExpectedLiveIsPinned || (liveRepo.isPinned === true) === args.expectedLiveIsPinned)
  )
  return { stillLive, livePinned: liveRepo?.isPinned === true }
}
