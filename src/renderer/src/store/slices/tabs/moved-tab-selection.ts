import {
  editSessionSource,
  type SessionSourceSet,
  type SessionSourceEdit,
  type OrdinarySourcePartial
} from '../../session-source-edits'
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
function movedTabSelectionPatch(
  edit: SessionSourceEdit<AppState>,
  intent: MovedTabSelection
): OrdinarySourcePartial<AppState> | undefined {
  const state = edit.view()
  const { worktreeId } = intent
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === intent.tabId)
  if (!tab || tab.groupId === intent.fromGroupId) {
    return undefined
  }
  // The preview kept, no focus time recorded.
  tabActivationPatch(
    edit,
    tab,
    worktreeId,
    { preservePreview: true, recordFocus: false },
    endsPreviewHere(state, worktreeId)
  )
  return state.activeWorktreeId === worktreeId
    ? buildActiveSurfacePatch(edit, worktreeId, tab.groupId)
    : {}
}

/** `patch` plus the selection of each moved tab it shows out of its old group, and those moves. */
export function withMovedTabSelections(
  before: AppState,
  edit: SessionSourceEdit<AppState>
): { patch: OrdinarySourcePartial<AppState>; taken: MovedTabSelection[] } {
  let next: OrdinarySourcePartial<AppState> = {}
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
    const selected = movedTabSelectionPatch(edit, intent)
    if (selected) {
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
  const edit = editSessionSource(state)
  let patch: OrdinarySourcePartial<AppState> = {}
  for (const intent of taken) {
    patch = { ...patch, ...movedTabSelectionPatch(edit, intent) }
  }
  return edit.view(patch)
}

/** Writes a frame's patch, with the selection of each moved tab it shows; returns those moves. */
export function showFramePatch(
  store: { getState: () => AppState; setState: SessionSourceSet<AppState> },
  edit: SessionSourceEdit<AppState>,
  patch: OrdinarySourcePartial<AppState> = {}
): MovedTabSelection[] {
  const shown = withMovedTabSelections(store.getState(), edit)
  if (edit.changed || Object.keys(patch).length || Object.keys(shown.patch).length) {
    store.setState(edit.finish({ ...patch, ...shown.patch }))
  }
  return shown.taken
}
