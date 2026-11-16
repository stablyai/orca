import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { settleEvictedModalData } from './modal-slot-dismissal'
import {
  canHostWorkspaceComposerPane,
  captureWorkspaceComposerPaneOrigin
} from '@/lib/workspace/creation/workspace-composer-pane-surface'

function replaceModalSlot(
  set: UISliceSet,
  get: UISliceGet,
  modal: UISlice['activeModal'],
  data: Record<string, unknown>
): void {
  const evicted = get().modalData
  set({ activeModal: modal, modalData: data })
  settleEvictedModalData(evicted)
}

function replaceComposerPane(
  set: UISliceSet,
  get: UISliceGet,
  request: UISlice['workspaceComposerPaneRequest']
): void {
  const evicted = get().workspaceComposerPaneRequest
  set({ workspaceComposerPaneRequest: request })
  if (evicted) {
    settleEvictedModalData(evicted.data)
  }
}

export function createUiModalActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  let lastPaneRequestId = 0
  return {
    activeModal: 'none',
    modalData: {},
    workspaceComposerPaneRequest: null,
    openModal: (modal, data = {}) => {
      if (modal === 'add-repo' || modal === 'create-worktree') {
        get().recordFeatureInteraction?.('workspace-creation')
      }
      if (modal !== 'new-workspace-composer') {
        replaceModalSlot(set, get, modal, data)
        return
      }
      // Why: one composer at a time; the pane leaves the slot to unrelated dialogs over it.
      if (canHostWorkspaceComposerPane(get(), data)) {
        if (get().activeModal !== 'none') {
          replaceModalSlot(set, get, 'none', {})
        }
        lastPaneRequestId += 1
        const origin = captureWorkspaceComposerPaneOrigin(get())
        replaceComposerPane(set, get, { id: lastPaneRequestId, data, origin })
        return
      }
      replaceComposerPane(set, get, null)
      replaceModalSlot(set, get, modal, data)
    },
    closeModal: () => replaceModalSlot(set, get, 'none', {}),
    closeWorkspaceComposerPane: (request) => {
      if (get().workspaceComposerPaneRequest === request) {
        replaceComposerPane(set, get, null)
      }
    }
  }
}
