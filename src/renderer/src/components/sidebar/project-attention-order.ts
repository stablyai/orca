import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  buildAttentionByWorktree,
  hasFreshAttributedAgentStatus,
  type WorktreeAttention
} from './smart-attention'

type ProjectAttentionState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'runtimePaneTitlesByTabId'
  | 'ptyIdsByTabId'
  | 'migrationUnsupportedByPtyId'
  | 'terminalLayoutsByTabId'
>

/** Per-worktree Smart attention, the input the "Attention" project order ranks projects by. */
export function buildProjectAttentionFromState(
  state: ProjectAttentionState,
  worktrees: readonly Worktree[],
  now = Date.now()
): Map<string, WorktreeAttention> {
  return buildAttentionByWorktree(
    [...worktrees],
    state.tabsByWorktree,
    state.agentStatusByPaneKey,
    state.runtimePaneTitlesByTabId,
    state.ptyIdsByTabId,
    now,
    state.migrationUnsupportedByPtyId,
    state.terminalLayoutsByTabId
  )
}

type SharedProjectAttentionState = ProjectAttentionState & Pick<AppState, 'worktreesByRepo'>

let sharedAttentionInputs: readonly unknown[] | undefined
let sharedAttention: Map<string, WorktreeAttention> | undefined

/**
 * Attention for every worktree, computed once per distinct input set and shared by all
 * compact project headers, so N headers don't each rescan agent statuses per store write.
 */
export function getSharedProjectAttentionFromState(
  state: SharedProjectAttentionState,
  now: number
): Map<string, WorktreeAttention> {
  const inputs = [
    state.worktreesByRepo,
    state.tabsByWorktree,
    state.agentStatusByPaneKey,
    state.runtimePaneTitlesByTabId,
    state.ptyIdsByTabId,
    state.migrationUnsupportedByPtyId,
    state.terminalLayoutsByTabId,
    now
  ]
  if (
    !sharedAttention ||
    !sharedAttentionInputs ||
    inputs.some((input, index) => input !== sharedAttentionInputs?.[index])
  ) {
    sharedAttention = buildProjectAttentionFromState(
      state,
      getIndexedAllWorktrees(state.worktreesByRepo),
      now
    )
    sharedAttentionInputs = inputs
  }
  return sharedAttention
}

/**
 * Whether live agent evidence exists yet. Before it does, every project would read as idle,
 * so the Attention order keeps the persisted Smart snapshot instead (see use-sort-order.ts).
 */
export function hasLiveSmartAttentionSignal(
  state: ProjectAttentionState,
  now = Date.now()
): boolean {
  const hasAnyLivePty = Object.values(state.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
  )
  return (
    hasAnyLivePty ||
    hasFreshAttributedAgentStatus(state.agentStatusByPaneKey, now, state.tabsByWorktree)
  )
}
