import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { settleEvictedModalData } from '../modal-slot-dismissal'
import { readAddProjectTarget } from '../../../lib/added-project-group-assignment'

// Why: the steps an Add Project flow can pass through. Every openModal reassigns the target, so
// any other modal ends the flow and drops it rather than arming it for an unrelated add.
const ADD_PROJECT_TARGET_MODALS = new Set<UISlice['activeModal']>([
  'add-repo',
  'confirm-non-git-folder'
])

export function createUiModalActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    activeModal: 'none',
    modalData: {},
    addProjectTarget: null,
    clearAddProjectTarget: () => set({ addProjectTarget: null }),
    openModal: (modal, data = {}) => {
      if (modal === 'add-repo' || modal === 'create-worktree') {
        get().recordFeatureInteraction?.('workspace-creation')
      }
      const evicted = get().modalData
      set({
        activeModal: modal,
        modalData: data,
        addProjectTarget: ADD_PROJECT_TARGET_MODALS.has(modal) ? readAddProjectTarget(data) : null
      })
      settleEvictedModalData(evicted)
    },
    closeModal: () => {
      const evicted = get().modalData
      set({ activeModal: 'none', modalData: {}, addProjectTarget: null })
      settleEvictedModalData(evicted)
    }
  }
}
