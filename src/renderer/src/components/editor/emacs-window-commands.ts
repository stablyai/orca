import { activateWorkspaceTab, type ActivateWorkspaceTabStore } from '@/lib/activate-workspace-tab'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { collectLayoutLeafGroupIds } from '../../../../shared/workspace-layout/tab-group-layout-tree'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type { EmacsEditorHooks, EmacsWindowSplitDirection } from './monaco-emacs-mode'

// Emacs windows map onto Orca's split groups: a group is a window, the tab it shows is the buffer
// in it. `C-x 2`/`C-x 3` open the same file in a new group, `C-x o` walks the layout, `C-x 0`
// closes this view and leaves the file open in its other windows.

/** The editor view an Emacs window command acts on. */
export type EmacsWindowView = { worktreeId: string; fileId: string; viewStateId: string }

export const EDITOR_VIEW_ATTRIBUTE = 'data-orca-editor-view'

export type EmacsWindowState = ActivateWorkspaceTabStore &
  Pick<
    AppState,
    | 'createEmptySplitGroup'
    | 'groupsByWorktree'
    | 'layoutByWorktree'
    | 'openFile'
    | 'openFiles'
    | 'unifiedTabsByWorktree'
  >

/** Read through `getState` so every step after a store action sees the updated tabs and groups. */
export type EmacsWindowStore = { getState: () => EmacsWindowState }

function viewTab(state: EmacsWindowState, view: EmacsWindowView) {
  return (
    (state.unifiedTabsByWorktree[view.worktreeId] ?? []).find(
      (tab) => tab.id === view.viewStateId
    ) ?? null
  )
}

function windowGroupIds(state: EmacsWindowState, worktreeId: string): string[] {
  return collectLayoutLeafGroupIds(state.layoutByWorktree[worktreeId])
}

const FOCUS_SETTLE_FRAMES = 30

function editorViewInput(viewStateId: string): HTMLElement | null {
  const selector = `[${EDITOR_VIEW_ATTRIBUTE}="${CSS.escape(viewStateId)}"] .monaco-editor`
  const input = document.querySelector(
    `${selector} .native-edit-context, ${selector} textarea.inputarea`
  )
  return input instanceof HTMLElement ? input : null
}

/** Moves keyboard focus into a mounted editor view; one that is not on screen is left alone. */
function focusEditorView(viewStateId: string): void {
  editorViewInput(viewStateId)?.focus()
}

// Bumped by every window command so a pending focus hold never fights the next one.
let focusHoldGeneration = 0

// Why: inserting a split re-parents the source group, so its editor remounts a few frames later and
// its mount focus would win; keep the new view focused until the layout has settled.
function holdFocusOnEditorView(
  viewStateId: string,
  generation = ++focusHoldGeneration,
  framesLeft = FOCUS_SETTLE_FRAMES
): void {
  if (generation !== focusHoldGeneration) {
    return
  }
  const input = editorViewInput(viewStateId)
  if (input && document.activeElement !== input) {
    input.focus()
  }
  if (framesLeft > 0) {
    requestAnimationFrame(() => holdFocusOnEditorView(viewStateId, generation, framesLeft - 1))
  }
}

export function splitEmacsWindow(
  store: EmacsWindowStore,
  view: EmacsWindowView,
  direction: EmacsWindowSplitDirection
): boolean {
  const state = store.getState()
  const tab = viewTab(state, view)
  const file = state.openFiles.find(
    (entry) => entry.id === view.fileId && entry.worktreeId === view.worktreeId
  )
  if (!tab || !file) {
    return false
  }
  const groupId = state.createEmptySplitGroup(view.worktreeId, tab.groupId, direction, {
    activate: true
  })
  if (!groupId) {
    return false
  }
  const { id: _id, isDirty: _isDirty, ...input } = file
  // Why: a second view of the open file, not a reopen.
  state.openFile(input, { targetGroupId: groupId })
  const created = (store.getState().unifiedTabsByWorktree[view.worktreeId] ?? []).find(
    (entry) => entry.entityId === view.fileId && entry.groupId === groupId
  )
  // Emacs moves point into the new window.
  if (created) {
    holdFocusOnEditorView(created.id)
  }
  return true
}

export function focusOtherEmacsWindow(store: EmacsWindowStore, view: EmacsWindowView): boolean {
  const state = store.getState()
  const tab = viewTab(state, view)
  if (!tab) {
    return false
  }
  const groupIds = windowGroupIds(state, view.worktreeId)
  const index = groupIds.indexOf(tab.groupId)
  if (index === -1 || groupIds.length < 2) {
    return false
  }
  const nextGroupId = groupIds[(index + 1) % groupIds.length]!
  const group = (state.groupsByWorktree[view.worktreeId] ?? []).find(
    (entry) => entry.id === nextGroupId
  )
  const target = (state.unifiedTabsByWorktree[view.worktreeId] ?? []).find(
    (entry) => entry.id === group?.activeTabId && entry.groupId === nextGroupId
  )
  if (!target) {
    state.focusGroup(view.worktreeId, nextGroupId)
    return true
  }
  const activated = activateWorkspaceTab(state, target)
  // Why: activation selects an editor tab without taking the keyboard; a terminal focuses itself.
  if (activated && isEditorTabContentType(target.contentType)) {
    focusEditorView(target.id)
  }
  return activated
}

export function deleteEmacsWindow(store: EmacsWindowStore, view: EmacsWindowView): boolean {
  const state = store.getState()
  // Why: Emacs refuses to delete the sole window; with one group the tab is the whole editor.
  if (!viewTab(state, view) || windowGroupIds(state, view.worktreeId).length < 2) {
    return false
  }
  return dispatchWorkspaceTabCommand({
    type: 'close',
    target: { kind: 'tab', worktreeId: view.worktreeId, tabId: view.viewStateId }
  })
}

/** Hooks for `installMonacoEmacsMode`; `view` is read per key so a remount never binds stale ids. */
export function createEmacsEditorHooks(
  view: () => EmacsWindowView | null,
  onSave: () => void
): EmacsEditorHooks {
  const withView = (run: (store: EmacsWindowStore, current: EmacsWindowView) => boolean) => {
    focusHoldGeneration += 1
    const current = view()
    if (current) {
      run(useAppStore, current)
    }
  }
  return {
    onSave,
    onSplitWindow: (direction) =>
      withView((store, current) => splitEmacsWindow(store, current, direction)),
    onOtherWindow: () => withView(focusOtherEmacsWindow),
    onDeleteWindow: () => withView(deleteEmacsWindow)
  }
}
