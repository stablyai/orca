import type { Tab } from '../../../../shared/tab-types'
import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'

/** The change, for the tab-bar tab main knows it by. */
export type TabChange = (
  tabBarTabId: string
) => Extract<WindowLayoutCommand, { type: 'renameTab' | 'setTabProps' }>

type TabOwnerState = WorktreeRuntimeOwnerState & { unifiedTabsByWorktree: Record<string, Tab[]> }

/** What the caller does once main answers: `shown` once main changed its copy, which its frame
 *  draws (the change's own effects, never the change), `refused` when main refuses it. */
export type TabChangeAnswers = { shown?: () => void; refused?: () => void }

/**
 * A tab's own change (title, color, view, launch agent) in a layout-owner build: main changes its
 * copy and its frame draws the change. `local` runs when a paired server holds the tab instead.
 * False when main is not asked (no such tab-bar tab, or a paired server owns the workspace): the
 * caller runs `local`.
 */
export function sendTabChangeToLayoutOwner(
  state: TabOwnerState,
  tab: Pick<Tab, 'id' | 'worktreeId'> | undefined,
  change: TabChange,
  local: () => void,
  answers: TabChangeAnswers = {}
): boolean {
  if (!tab) {
    return false
  }
  return sendLayoutApply(state, tab.worktreeId, change(tab.id), {
    apply: () => answers.shown?.(),
    asToday: local,
    refused: answers.refused
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
  answers?: TabChangeAnswers
): boolean {
  const tab = findRenamableUnifiedTab(state.unifiedTabsByWorktree, tabId)
  if (sendTabChangeToLayoutOwner(state, tab, change, local, answers)) {
    return true
  }
  local()
  return false
}
