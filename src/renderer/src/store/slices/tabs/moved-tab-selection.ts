// Select moved tabs with the frame showing the move (L120); a later reply may already be superseded by another drag.

import type { AppState } from '../../types'
import {
  dropMovedTabSelection,
  pendingMovedTabSelections,
  type MovedTabSelection
} from '@/runtime/layout-owner-pane-intents'
import { tabActivationPatch } from './tabs-focus-actions'
import { endsPreviewHere } from './preview-tab-promotion'
import { buildActiveSurfacePatch } from './tabs-surface'

type SelectionState = Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>

/** The workspace's selection: its active group and each group's active tab. */
export function tabSelectionKey(state: SelectionState, worktreeId: string): string {
  const groups = (state.groupsByWorktree[worktreeId] ?? []).map(
    (group) => `${group.id}:${group.activeTabId ?? ''}`
  )
  return `${state.activeGroupIdByWorktree[worktreeId] ?? ''}|${groups.join(',')}`
}

/** `state` with the moved tab selected, as the window's own move selects it; unchanged when
 *  `state` does not show the tab out of its old group. */
function movedTabSelectionPatch(state: AppState, intent: MovedTabSelection): Partial<AppState> {
  const { worktreeId } = intent
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === intent.tabId)
  if (!tab || tab.groupId === intent.fromGroupId) {
    return {}
  }
  // The preview kept, no focus time recorded.
  const selected = tabActivationPatch(
    state,
    tab,
    worktreeId,
    { preservePreview: true, recordFocus: false },
    endsPreviewHere(state, worktreeId)
  )
  return {
    ...selected,
    // As focusing a group does: only the active workspace's surface follows.
    ...(state.activeWorktreeId === worktreeId
      ? buildActiveSurfacePatch({ ...state, ...selected }, worktreeId, tab.groupId)
      : {})
  }
}

/** `patch` plus the selection of each moved tab it shows out of its old group, and those moves. */
export function withMovedTabSelections(
  before: AppState,
  patch: Partial<AppState>
): { patch: Partial<AppState>; taken: MovedTabSelection[] } {
  let next: Partial<AppState> = patch
  const taken: MovedTabSelection[] = []
  for (const intent of pendingMovedTabSelections()) {
    if (intent.selection === null) {
      continue
    }
    if (tabSelectionKey(before, intent.worktreeId) !== intent.selection) {
      // The user selected or dragged again since the move.
      dropMovedTabSelection(intent)
      continue
    }
    const selected = movedTabSelectionPatch({ ...before, ...next }, intent)
    if (Object.keys(selected).length > 0) {
      dropMovedTabSelection(intent)
      taken.push(intent)
      next = { ...next, ...selected }
    }
  }
  return { patch: next, taken }
}

/** `state` with each of `taken`'s moved tabs selected, as the frame that took them selects it. */
export function withMovedTabsSelected(
  state: AppState,
  taken: readonly MovedTabSelection[]
): AppState {
  return taken.reduce<AppState>(
    (next, intent) => ({ ...next, ...movedTabSelectionPatch(next, intent) }),
    state
  )
}

/** Writes a frame's patch, with the selection of each moved tab it shows; returns those moves. */
export function showFramePatch(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  patch: Partial<AppState>
): MovedTabSelection[] {
  if (Object.keys(patch).length === 0) {
    return []
  }
  const shown = withMovedTabSelections(store.getState(), patch)
  store.setState(shown.patch)
  return shown.taken
}
