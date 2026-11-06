import {
  getPinnedGroupKey,
  getPinnedOccurrenceGroupId,
  type PinnedGroupSettings
} from '../pinned-groups'
import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import { getWorktreeExecutionHostId } from '../execution-host'
import type { ExecutionHostId } from '../execution-host'
import { PINNED_GROUP_KEY } from './group-keys'
import { appendWorktreeRows } from './row-builders'
import type { RepoOfWorktree, Row } from './row-types'

export function emitPinnedGroup(
  pinnedSectionWorktrees: Worktree[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId,
  collapsedGroups: Set<string>,
  result: Row[],
  occurrencePlan: WorktreeOccurrencePlan<Worktree>,
  hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>,
  settings: PinnedGroupSettings = {}
): void {
  if (pinnedSectionWorktrees.length === 0 && !settings.pinnedGroups?.length) {
    return
  }
  const hostWorktreeCounts = new Map<ExecutionHostId, number>()
  const hostWorktreeIds = new Map<ExecutionHostId, string[]>()
  for (const worktree of pinnedSectionWorktrees) {
    const hostId = getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId)
    hostWorktreeCounts.set(hostId, (hostWorktreeCounts.get(hostId) ?? 0) + 1)
    const hostIds = hostWorktreeIds.get(hostId) ?? []
    hostIds.push(worktree.id)
    hostWorktreeIds.set(hostId, hostIds)
  }

  result.push({
    type: 'header',
    key: PINNED_GROUP_KEY,
    count: pinnedSectionWorktrees.length,
    icon: { kind: 'pinned' },
    hostWorktreeCounts,
    hostWorktreeIds,
    worktreeIds: pinnedSectionWorktrees.map((worktree) => worktree.id)
  })
  if (collapsedGroups.has(PINNED_GROUP_KEY)) {
    return
  }

  const occurrences = occurrencePlan.bySection.get(PINNED_GROUP_KEY) ?? []
  const groupIdByOccurrenceKey = new Map(
    occurrences.map((occurrence) => [
      occurrence.key,
      getPinnedOccurrenceGroupId(occurrence, settings)
    ])
  )
  const appendGroup = (groupId: string | undefined): void => {
    appendWorktreeRows(result, repoOf, occurrencePlan, {
      collapsedGroups,
      groupDepth: groupId === undefined ? 0 : 1,
      sectionKey: PINNED_GROUP_KEY,
      occurrenceFilter: (occurrence) => groupIdByOccurrenceKey.get(occurrence.key) === groupId,
      hostContextLabelByWorktreeIdentity
    })
  }
  appendGroup(undefined)
  for (const group of [...(settings.pinnedGroups ?? [])].sort((a, b) => a.order - b.order)) {
    const members = occurrences
      .filter((occurrence) => groupIdByOccurrenceKey.get(occurrence.key) === group.id)
      .map((occurrence) => occurrence.row)
    const groupHostIds = new Map<ExecutionHostId, string[]>()
    for (const worktree of members) {
      const hostId = getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId)
      const ids = groupHostIds.get(hostId) ?? []
      ids.push(worktree.id)
      groupHostIds.set(hostId, ids)
    }
    const key = getPinnedGroupKey(group.id)
    result.push({
      type: 'header',
      key,
      collapseKey: key,
      label: group.name,
      icon: { kind: 'pinned' },
      projectGroupDepth: 1,
      count: members.length,
      worktreeIds: members.map((worktree) => worktree.id),
      hostWorktreeCounts: new Map([...groupHostIds].map(([hostId, ids]) => [hostId, ids.length])),
      hostWorktreeIds: groupHostIds
    })
    if (!collapsedGroups.has(key)) {
      appendGroup(group.id)
    }
  }
}
