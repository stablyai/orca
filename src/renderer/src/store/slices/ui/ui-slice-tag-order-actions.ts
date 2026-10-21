import type { UISlice, UISliceSet } from './ui-slice-contract'
import { normalizeManualTagOrder } from '../../../../../shared/worktree/manual-tag-order'

/** How the sidebar orders tag sections, and the drag-committed order behind `manual`. */
export function createUiTagOrderActions(set: UISliceSet): Partial<UISlice> {
  return {
    tagOrderBy: 'name',
    // Why its own write rather than the debounced writer: `ui.set` params are
    // strict, so a host that predates this field rejects the whole patch it
    // rides in. Alone, only this write is lost against such a host.
    setTagOrderBy: (t) => {
      set({ tagOrderBy: t })
      window.api.ui.set({ tagOrderBy: t }).catch(console.error)
    },
    manualTagOrder: [],
    setManualTagOrder: (order) => {
      const manualTagOrder = normalizeManualTagOrder(order)
      set({ manualTagOrder })
      // Why an immediate write: a drop must survive a quit before the debounced writer fires.
      window.api.ui.set({ manualTagOrder }).catch(console.error)
    }
  }
}
