// Mirror window-set tab order to main so the subsequent save cannot reorder anchored creates or paired-client moves.

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
