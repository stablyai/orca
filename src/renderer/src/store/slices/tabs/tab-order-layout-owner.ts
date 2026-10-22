// A layout-owner build's record of a tab order the window set itself (an anchored create, a
// paired client's reorder): main moves the same tabs, so the window's save changes no order.

import { recordLayoutApply } from '@/runtime/layout-apply-send'
import { tabOrderAnchor, tabOrderMoves } from '../../../../../shared/workspace-layout/tab-order'
import type { AppState } from '../../types'

export function recordTabOrderInLayoutOwner(
  state: AppState,
  groupId: string,
  change: { worktreeId: string; from: readonly string[]; to: readonly string[] }
): void {
  for (const { tabId, index } of tabOrderMoves(change.from, change.to)) {
    recordLayoutApply(state, change.worktreeId, {
      type: 'moveTab',
      tabId,
      toGroupId: groupId,
      index,
      // Each step leaves `to`'s prefix through `index` in place.
      afterTabId: tabOrderAnchor(change.to, index)
    })
  }
}
