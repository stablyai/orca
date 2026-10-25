import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabContentType } from '../../../shared/tab-types'
import {
  findAmbiguousWorktreeIds,
  getPaletteOwnershipWorktreeIds,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import { activateAndRevealWorkspace } from './worktree-activation'

export type UnifiedTabPaletteTarget = {
  executionHostId?: ExecutionHostId
  tabId: string
  worktreeId: string
}

export type UnifiedTabPaletteRevealResult =
  | { status: 'revealed'; tab: Tab }
  | { status: 'blocked' }
  | { status: 'failed'; reason: 'missing-tab' | 'missing-worktree' }

/** Shows the workspace of a palette or switcher row whose one owned unified tab has this ID. */
export function revealUnifiedTabPaletteTarget(
  { executionHostId, tabId, worktreeId }: UnifiedTabPaletteTarget,
  contentType: TabContentType
): UnifiedTabPaletteRevealResult {
  const state = useAppStore.getState()
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state))
  if (!executionHostId && ambiguousWorktreeIds.has(worktreeId)) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (candidate) => candidate.id === tabId
  )
  const tab = tabs[0]
  if (
    tabs.length !== 1 ||
    tab.contentType !== contentType ||
    !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
  ) {
    return { status: 'failed', reason: 'missing-tab' }
  }
  const targetHostId = executionHostId ?? worktree.hostId
  const revealed = activateAndRevealWorkspace(
    worktree.id,
    targetHostId ? { executionHostId: targetHostId } : {}
  )
  return revealed ? { status: 'revealed', tab } : { status: 'blocked' }
}
