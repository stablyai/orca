import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  buildWorktreeOccurrencePlan,
  type WorktreeOccurrencePlan
} from '../worktree-occurrence-plan'
import { NEEDS_ATTENTION_GROUP_KEY } from './group-keys'
import { getLaneHostWorktreeCounts, getLaneHostWorktreeIds } from './host-labels'
import { appendWorktreeRows } from './row-builders'
import type { Row } from './row-types'

/**
 * Occurrences for the "Needs you" section: copies of workspaces whose agent is blocked on the user.
 *
 * Why a separate plan: each workspace keeps its row in its own group, and reveal reads the main
 * plan's preferred occurrence, so a copy never steals reveal, drag order or lineage from that row.
 * Why flat: a blocked child is listed on its own; its lineage stays in its own group.
 */
export function planNeedsAttentionOccurrences(
  needsAttentionWorktrees: readonly Worktree[]
): WorktreeOccurrencePlan<Worktree> {
  return buildWorktreeOccurrencePlan({
    rows: needsAttentionWorktrees,
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: new Map(),
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: ({ natural }) => [{ key: NEEDS_ATTENTION_GROUP_KEY, items: natural }]
  })
}

export function emitNeedsAttentionGroup(
  needsAttentionWorktrees: readonly Worktree[],
  occurrencePlan: WorktreeOccurrencePlan<Worktree>,
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId,
  collapsedGroups: Set<string>,
  result: Row[],
  hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>
): void {
  if (needsAttentionWorktrees.length === 0) {
    return
  }
  result.push({
    type: 'header',
    key: NEEDS_ATTENTION_GROUP_KEY,
    count: needsAttentionWorktrees.length,
    icon: { kind: 'needs-attention' },
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      needsAttentionWorktrees,
      [],
      repoMap,
      defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(needsAttentionWorktrees, [], repoMap, defaultHostId),
    worktreeIds: needsAttentionWorktrees.map((worktree) => worktree.id)
  })
  if (collapsedGroups.has(NEEDS_ATTENTION_GROUP_KEY)) {
    return
  }
  appendWorktreeRows(result, repoMap, occurrencePlan, {
    collapsedGroups,
    groupDepth: 0,
    sectionKey: NEEDS_ATTENTION_GROUP_KEY,
    hostContextLabelByWorktreeIdentity
  })
}
