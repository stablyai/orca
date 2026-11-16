import type { Worktree } from '../../worktree/types'
import { getWorktreeExecutionHostId } from '../../execution-host'
import type { ExecutionHostId } from '../../execution-host'
import { PINNED_GROUP_KEY } from './group-keys'
import { appendWorktreeRows } from './row-builders'
import type { SectionAppendContext } from './group-sections'

export function emitPinnedGroup(
  ctx: SectionAppendContext,
  pinnedSectionWorktrees: Worktree[]
): void {
  const { result, repoOf, defaultHostId, collapsedGroups, occurrencePlan } = ctx
  if (pinnedSectionWorktrees.length === 0) {
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

  appendWorktreeRows(result, repoOf, occurrencePlan, {
    collapsedGroups,
    groupDepth: 0,
    sectionKey: PINNED_GROUP_KEY,
    hostContextLabelByWorktreeIdentity: ctx.mixedWorktreeHostContextLabels,
    folderPairByIdentity: ctx.folderPairByIdentity
  })
}
