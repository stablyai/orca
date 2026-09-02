import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { settleEvictedModalData } from '../modal-slot-dismissal'

export function createUiModalActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    activeModal: 'none',
    modalData: {},
    openModal: (modal, data = {}) => {
      if (modal === 'add-repo' || modal === 'create-worktree') {
        get().recordFeatureInteraction?.('workspace-creation')
      }
      const evicted = get().modalData
      set({
        activeModal: modal,
        modalData: data
      })
      settleEvictedModalData(evicted)
    },
    closeModal: () => {
      const evicted = get().modalData
      set({ activeModal: 'none', modalData: {} })
      settleEvictedModalData(evicted)
    }
  }
}
