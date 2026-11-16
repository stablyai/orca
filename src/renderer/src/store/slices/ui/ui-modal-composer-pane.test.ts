import { describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'
import { MODAL_DISMISSED_KEY } from './modal-slot-dismissal'
import { getDefaultSettings } from '../../../../../shared/constants'
import {
  resolveWorkspaceComposerPaneExit,
  selectWorkspaceComposerPaneActive
} from '@/lib/workspace/creation/workspace-composer-pane-surface'

function storeWithPromptFirst(promptFirstComposer = true) {
  const store = createUIStore()
  store.setState({
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    activePendingCreationId: null,
    pendingWorktreeCreations: {},
    settings: { ...getDefaultSettings('/tmp'), promptFirstComposer }
  })
  return store
}

describe('prompt-first composer pane request', () => {
  it('hosts the composer in the pane and leaves the modal slot free', () => {
    const store = storeWithPromptFirst()
    const data = { initialRepoId: 'repo-1' }

    store.getState().openModal('new-workspace-composer', data)

    expect(store.getState().activeModal).toBe('none')
    expect(store.getState().workspaceComposerPaneRequest?.data).toBe(data)
  })

  it('keeps the same pane request while an unrelated dialog opens and closes over it', () => {
    const store = storeWithPromptFirst()
    const onDismissed = vi.fn()
    store.getState().openModal('new-workspace-composer', { [MODAL_DISMISSED_KEY]: onDismissed })
    const request = store.getState().workspaceComposerPaneRequest

    store.getState().openModal('delete-worktree', { worktreeId: 'wt-1' })
    store.getState().closeModal()

    expect(store.getState().workspaceComposerPaneRequest).toBe(request)
    expect(onDismissed).not.toHaveBeenCalled()
  })

  it('reopening issues a new request and settles the replaced one once', () => {
    const store = storeWithPromptFirst()
    const onDismissed = vi.fn()
    store.getState().openModal('new-workspace-composer', { [MODAL_DISMISSED_KEY]: onDismissed })
    const first = store.getState().workspaceComposerPaneRequest!

    store.getState().openModal('new-workspace-composer', { initialRepoId: 'repo-2' })
    store.getState().closeWorkspaceComposerPane(first)

    const reopened = store.getState().workspaceComposerPaneRequest
    expect(reopened?.id).not.toBe(first.id)
    expect(reopened?.data).toEqual({ initialRepoId: 'repo-2' })
    expect(onDismissed).toHaveBeenCalledOnce()
  })

  it('closing settles the dismissal callback exactly once', () => {
    const store = storeWithPromptFirst()
    const onDismissed = vi.fn()
    store.getState().openModal('new-workspace-composer', { [MODAL_DISMISSED_KEY]: onDismissed })
    const request = store.getState().workspaceComposerPaneRequest!

    store.getState().closeWorkspaceComposerPane(request)
    store.getState().closeWorkspaceComposerPane(request)

    expect(store.getState().workspaceComposerPaneRequest).toBeNull()
    expect(onDismissed).toHaveBeenCalledOnce()
  })
})

describe('prompt-first composer dialog fallback', () => {
  it('falls back to the dialog when the setting is off', () => {
    const store = storeWithPromptFirst(false)

    store.getState().openModal('new-workspace-composer', {})

    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().workspaceComposerPaneRequest).toBeNull()
  })

  it('falls back to the dialog outside the workspace view', () => {
    const store = storeWithPromptFirst()
    store.setState({ activeView: 'settings' })

    store.getState().openModal('new-workspace-composer', {})

    expect(store.getState().activeModal).toBe('new-workspace-composer')
  })

  it('opening the dialog composer replaces an open pane composer', () => {
    const store = storeWithPromptFirst()
    const onDismissed = vi.fn()
    store.getState().openModal('new-workspace-composer', { [MODAL_DISMISSED_KEY]: onDismissed })

    store.getState().openModal('new-workspace-composer', { directSetup: { id: 'setup-1' } })

    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().workspaceComposerPaneRequest).toBeNull()
    expect(onDismissed).toHaveBeenCalledOnce()
  })

  it('stops showing the pane once the user navigates to another workspace', () => {
    const store = storeWithPromptFirst()
    store.getState().openModal('new-workspace-composer', {})

    store.setState({ activeWorktreeId: 'wt-2' })

    expect(selectWorkspaceComposerPaneActive(store.getState())).toBe(false)
  })
})

describe('prompt-first composer when a creation takes the center', () => {
  it('moves the open pane composer to the dialog without settling it', () => {
    const store = storeWithPromptFirst()
    const onDismissed = vi.fn()
    const data = { [MODAL_DISMISSED_KEY]: onDismissed }
    store.getState().openModal('new-workspace-composer', data)
    const request = store.getState().workspaceComposerPaneRequest!
    store.setState({
      activePendingCreationId: 'creation-1',
      pendingWorktreeCreations: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the creation surface reads only loaderVisible and status.
        'creation-1': { loaderVisible: true } as never
      }
    })

    expect(resolveWorkspaceComposerPaneExit(store.getState(), request)).toBe('move-to-dialog')
    store.getState().moveWorkspaceComposerPaneToDialog(request)

    expect(store.getState().workspaceComposerPaneRequest).toBeNull()
    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().modalData).toBe(data)
    expect(onDismissed).not.toHaveBeenCalled()
  })

  it('dismisses the pane composer when the user switches workspaces', () => {
    const store = storeWithPromptFirst()
    store.getState().openModal('new-workspace-composer', {})
    const request = store.getState().workspaceComposerPaneRequest!

    store.setState({ activeWorktreeId: 'wt-2' })

    expect(resolveWorkspaceComposerPaneExit(store.getState(), request)).toBe('dismiss')
  })
})
