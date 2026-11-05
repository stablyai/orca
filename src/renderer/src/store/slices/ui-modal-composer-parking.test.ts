import { describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'
import { MODAL_DISMISSED_KEY } from './modal-slot-dismissal'
import { getDefaultSettings } from '../../../../shared/constants'

function storeWithComposerPane(promptFirstComposer = true) {
  const store = createUIStore()
  store.setState({
    activeView: 'terminal',
    activePendingCreationId: null,
    pendingWorktreeCreations: {},
    settings: { ...getDefaultSettings('/tmp'), promptFirstComposer }
  })
  return store
}

describe('UI modal slot with the prompt-first composer pane', () => {
  it('restores the pane composer when a modal opened over it closes', () => {
    const store = storeWithComposerPane()
    const composerData = { initialRepoId: 'repo-1' }

    store.getState().openModal('new-workspace-composer', composerData)
    store.getState().openModal('delete-worktree', { worktreeId: 'wt-1' })
    store.getState().closeModal()

    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().modalData).toBe(composerData)
  })

  it('replaces the dialog composer when the setting is off', () => {
    const store = storeWithComposerPane(false)

    store.getState().openModal('new-workspace-composer', {})
    store.getState().openModal('delete-worktree', {})
    store.getState().closeModal()

    expect(store.getState().activeModal).toBe('none')
  })

  it('drops a parked composer without closing the modal above it', () => {
    const store = storeWithComposerPane()
    const onDismissed = vi.fn()

    store.getState().openModal('new-workspace-composer', { [MODAL_DISMISSED_KEY]: onDismissed })
    store.getState().openModal('worktree-palette', {})
    store.getState().closeWorkspaceComposer()
    store.getState().closeModal()

    expect(onDismissed).toHaveBeenCalledOnce()
    expect(store.getState().activeModal).toBe('none')
  })

  it('reopening the composer over a modal discards the parked one', () => {
    const store = storeWithComposerPane()
    const reopened = { initialRepoId: 'repo-2' }

    store.getState().openModal('new-workspace-composer', { initialRepoId: 'repo-1' })
    store.getState().openModal('worktree-palette', {})
    store.getState().openModal('new-workspace-composer', reopened)
    store.getState().closeModal()

    expect(store.getState().activeModal).toBe('none')
    expect(store.getState().parkedComposerModalData).toBeNull()
  })
})
