import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { resolveAttentionProjectOrderToggle } from './attention-project-order-toggle'

export function createAttentionProjectOrderActions(
  set: UISliceSet,
  get: UISliceGet
): Partial<UISlice> {
  return {
    // Why in-memory: the restore point is a session convenience; after a restart, off means Manual.
    attentionProjectOrderRestore: null,
    toggleAttentionProjectOrder: () => {
      const state = get()
      const compactProjectRows = state.settings?.compactProjectRows === true
      const next = resolveAttentionProjectOrderToggle({
        projectOrderBy: state.projectOrderBy,
        compactProjectRows,
        restore: state.attentionProjectOrderRestore
      })
      set({ projectOrderBy: next.projectOrderBy, attentionProjectOrderRestore: next.restore })
      if (next.compactProjectRows !== compactProjectRows) {
        void state.updateSettings({ compactProjectRows: next.compactProjectRows })
      }
    },
    // Why clear the restore point: a direct choice supersedes what the header toggle would put back.
    setCompactProjectRows: (enabled) => {
      set({ attentionProjectOrderRestore: null })
      void get().updateSettings({ compactProjectRows: enabled })
    }
  }
}
