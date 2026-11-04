import { describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'
import { MODAL_DISMISSED_KEY } from './modal-slot-dismissal'

function dismissalData(onDismissed: () => void): Record<string, unknown> {
  return { [MODAL_DISMISSED_KEY]: onDismissed }
}

describe('UI modal slot dismissal', () => {
  it('updates the slot before notifying the evicted entry', () => {
    const store = createUIStore()
    const observedModal = vi.fn(() => store.getState().activeModal)

    store.getState().openModal('worktree-palette', dismissalData(observedModal))
    store.getState().openModal('quick-open')

    expect(observedModal).toHaveReturnedWith('quick-open')
  })

  it('settles reentrant replacement and close paths once', () => {
    const store = createUIStore()
    const replacementDismissed = vi.fn()
    const reentrantDismissed = vi.fn()
    const firstDismissed = vi.fn(() => {
      store.getState().openModal('quick-open', dismissalData(reentrantDismissed))
    })

    store.getState().openModal('worktree-palette', dismissalData(firstDismissed))
    store.getState().openModal('add-repo', dismissalData(replacementDismissed))
    store.getState().closeModal()

    expect(firstDismissed).toHaveBeenCalledOnce()
    expect(replacementDismissed).toHaveBeenCalledOnce()
    expect(reentrantDismissed).toHaveBeenCalledOnce()
    expect(store.getState().activeModal).toBe('none')
  })
})
