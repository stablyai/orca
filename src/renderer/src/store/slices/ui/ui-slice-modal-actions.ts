import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { settleEvictedModalData } from '../modal-slot-dismissal'
import { selectWorkspaceComposerPaneActive } from '@/lib/workspace-composer-pane-surface'

export function createUiModalActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    activeModal: 'none',
    modalData: {},
    parkedComposerModalData: null,
    openModal: (modal, data = {}) => {
      if (modal === 'add-repo' || modal === 'create-worktree') {
        get().recordFeatureInteraction?.('workspace-creation')
      }
      const state = get()
      const evicted = state.modalData
      // Why: the pane is not modal, so a sidebar dialog opened over it must not discard the typed prompt.
      if (
        state.activeModal === 'new-workspace-composer' &&
        modal !== 'new-workspace-composer' &&
        selectWorkspaceComposerPaneActive(state)
      ) {
        set({ activeModal: modal, modalData: data, parkedComposerModalData: evicted })
        return
      }
      const parked = modal === 'new-workspace-composer' ? state.parkedComposerModalData : null
      set({
        activeModal: modal,
        modalData: data,
        ...(parked ? { parkedComposerModalData: null } : {})
      })
      settleEvictedModalData(evicted)
      if (parked) {
        settleEvictedModalData(parked)
      }
    },
    closeModal: () => {
      const evicted = get().modalData
      const parked = get().parkedComposerModalData
      set(
        parked
          ? {
              activeModal: 'new-workspace-composer',
              modalData: parked,
              parkedComposerModalData: null
            }
          : { activeModal: 'none', modalData: {} }
      )
      settleEvictedModalData(evicted)
    },
    closeWorkspaceComposer: () => {
      if (get().activeModal === 'new-workspace-composer') {
        get().closeModal()
        return
      }
      const parked = get().parkedComposerModalData
      if (parked) {
        set({ parkedComposerModalData: null })
        settleEvictedModalData(parked)
      }
    }
  }
}
