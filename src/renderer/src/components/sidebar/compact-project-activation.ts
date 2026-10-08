import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildProjectAttentionFromState } from './project-attention-order'
import { IDLE, type WorktreeAttention } from './smart-attention'

/** Which workspace a collapsed project row opens: most urgent agent, else most recent, else primary. */
export function pickCompactProjectTargetWorktree(
  worktrees: readonly Worktree[],
  attentionByWorktree: ReadonlyMap<string, WorktreeAttention>
): Worktree | undefined {
  let best: Worktree | undefined
  let bestAttention = IDLE
  for (const worktree of worktrees) {
    const attention = attentionByWorktree.get(worktree.id) ?? IDLE
    if (
      attention.cls < bestAttention.cls ||
      (attention.cls === bestAttention.cls &&
        attention.cls !== IDLE.cls &&
        attention.attentionTimestamp > bestAttention.attentionTimestamp)
    ) {
      best = worktree
      bestAttention = attention
    }
  }
  if (best) {
    return best
  }
  for (const worktree of worktrees) {
    if (worktree.lastActivityAt > 0 && worktree.lastActivityAt > (best?.lastActivityAt ?? 0)) {
      best = worktree
    }
  }
  return best ?? worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0]
}

/** The workspace a project row, or its Cmd+1–9 slot, opens right now. */
export function resolveCompactProjectWorktree(
  worktreeIds: readonly string[]
): { id: string; executionHostId?: ExecutionHostId } | undefined {
  const state = useAppStore.getState()
  const worktreeMap = getWorktreeMapFromState(state)
  const worktrees = worktreeIds.flatMap((id) => {
    const worktree = worktreeMap.get(id)
    return worktree ? [worktree] : []
  })
  const target = pickCompactProjectTargetWorktree(
    worktrees,
    buildProjectAttentionFromState(state, worktrees)
  )
  if (!target) {
    return undefined
  }
  const repo = getRepoMapFromState(state).get(target.repoId)
  const executionHostId = target.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  return { id: target.id, ...(executionHostId ? { executionHostId } : {}) }
}

export function activateCompactProject(worktreeIds: readonly string[]): void {
  const target = resolveCompactProjectWorktree(worktreeIds)
  if (target) {
    void activateWorktreeFromSidebar(target.id, target.executionHostId)
  }
}
