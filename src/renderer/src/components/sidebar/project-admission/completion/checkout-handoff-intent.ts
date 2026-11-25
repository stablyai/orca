import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

/**
 * The foreground the user faced when they asked to add a project. Any later change to it (another
 * modal or modal request, workspace, view or visible tab), or a newer add, hands the foreground
 * back to the user: the add may still finish its saved work but must neither navigate nor report.
 */
export type CheckoutHandoffIntent = {
  canReveal: () => boolean
  /** Closes the add's own modal without counting the close as the user leaving. */
  closeOwnModal: (close: () => void) => boolean
  dispose: () => void
}

let handoffGeneration = 0

function visibleSurface(state: AppState): readonly unknown[] {
  const worktreeId = state.activeWorktreeId
  const groupId = worktreeId ? state.activeGroupIdByWorktree[worktreeId] : undefined
  return [
    state.activeView,
    worktreeId ?? null,
    state.activeWorkspaceExecutionHostId ?? null,
    state.activeTabType,
    state.activeTabId,
    state.activeBrowserTabId,
    state.activeFileId,
    groupId ?? null,
    worktreeId
      ? (state.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)?.activeTabId ??
        null)
      : null
  ]
}

function sameSurface(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.every((value, index) => Object.is(value, right[index]))
}

export function captureCheckoutHandoffIntent(): CheckoutHandoffIntent {
  const generation = ++handoffGeneration
  const initial = useAppStore.getState()
  let modal = { activeModal: initial.activeModal, modalData: initial.modalData }
  const surface = visibleSurface(initial)
  let closingOwnModal = false
  let owned = true
  const observe = (state: AppState): boolean => {
    if (closingOwnModal) {
      return owned
    }
    owned &&=
      generation === handoffGeneration &&
      state.activeModal === modal.activeModal &&
      state.modalData === modal.modalData &&
      sameSurface(visibleSurface(state), surface)
    return owned
  }
  const unsubscribe = useAppStore.subscribe(observe)
  return {
    canReveal: () => observe(useAppStore.getState()),
    closeOwnModal: (close) => {
      if (!observe(useAppStore.getState())) {
        return false
      }
      closingOwnModal = true
      try {
        close()
      } finally {
        closingOwnModal = false
        const state = useAppStore.getState()
        modal = { activeModal: state.activeModal, modalData: state.modalData }
      }
      return observe(useAppStore.getState())
    },
    dispose: unsubscribe
  }
}
