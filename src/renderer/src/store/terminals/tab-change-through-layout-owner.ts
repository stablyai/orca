import type { Tab } from '../../../../shared/tab-types'
import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'

/** The change, for the tab-bar tab main knows it by. */
export type TabChange = (
  tabBarTabId: string
) => Extract<WindowLayoutCommand, { type: 'renameTab' | 'setTabProps' }>

type TabOwnerState = WorktreeRuntimeOwnerState & { unifiedTabsByWorktree: Record<string, Tab[]> }

/**
 * A tab's own change (title, color, view, launch agent) in a layout-owner build: main changes its
 * copy first, then `local` shows the same change, also when main lacks the tab; `refused` when main
 * refuses it. False when main is not asked (no such tab-bar tab, or a paired server owns the
 * workspace): the caller runs `local`.
 */
export function sendTabChangeToLayoutOwner(
  state: TabOwnerState,
  tab: Pick<Tab, 'id' | 'worktreeId'> | undefined,
  change: TabChange,
  local: () => void,
  refused?: () => void
): boolean {
  if (!tab) {
    return false
  }
  return sendLayoutApply(state, tab.worktreeId, change(tab.id), {
    apply: local,
    asToday: local,
    refused
  })
}

/**
 * As `sendTabChangeToLayoutOwner`, for a tab addressed as its rename and color are (a terminal by
 * its terminal's id); `local` runs at once when main is not asked. True when main was asked.
 */
export function sendRenamableTabChangeToLayoutOwner(
  state: TabOwnerState,
  tabId: string,
  change: TabChange,
  local: () => void,
  refused?: () => void
): boolean {
  const tab = findRenamableUnifiedTab(state.unifiedTabsByWorktree, tabId)
  if (sendTabChangeToLayoutOwner(state, tab, change, local, refused)) {
    return true
  }
  local()
  return false
}
