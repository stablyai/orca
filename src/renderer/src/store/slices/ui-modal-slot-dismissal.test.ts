import { describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'
import { MODAL_DISMISSED_KEY } from './modal-slot-dismissal'

function dismissalData(onDismissed: () => void): Record<string, unknown> {
  return { [MODAL_DISMISSED_KEY]: onDismissed }
}

describe('UI modal slot dismissal', () => {
  it('dismisses replaced and closed entries once', () => {
    const store = createUIStore()
    const firstDismissed = vi.fn()
    const secondDismissed = vi.fn()

    store.getState().openModal('worktree-palette', dismissalData(firstDismissed))
    store.getState().openModal('quick-open', dismissalData(secondDismissed))
    store.getState().closeModal()
    store.getState().closeModal()

    expect(firstDismissed).toHaveBeenCalledOnce()
    expect(secondDismissed).toHaveBeenCalledOnce()
  })

  it('dismisses each entry across consecutive replacements', () => {
    const store = createUIStore()
    const firstDismissed = vi.fn()
    const secondDismissed = vi.fn()
    const thirdDismissed = vi.fn()

    store.getState().openModal('worktree-palette', dismissalData(firstDismissed))
    store.getState().openModal('quick-open', dismissalData(secondDismissed))
    store.getState().openModal('add-repo', dismissalData(thirdDismissed))
    store.getState().closeModal()

    expect(firstDismissed).toHaveBeenCalledOnce()
    expect(secondDismissed).toHaveBeenCalledOnce()
    expect(thirdDismissed).toHaveBeenCalledOnce()
  })

  it('updates the slot before notifying the evicted entry', () => {
    const store = createUIStore()
    const observedModal = vi.fn(() => store.getState().activeModal)

    store.getState().openModal('worktree-palette', dismissalData(observedModal))
    store.getState().openModal('quick-open')

    expect(observedModal).toHaveReturnedWith('quick-open')
  })

  it('ignores modal data without a callable dismissal hook', () => {
    const store = createUIStore()

    store.getState().openModal('worktree-palette', { [MODAL_DISMISSED_KEY]: 'invalid' })

    expect(() => store.getState().openModal('quick-open')).not.toThrow()
    expect(store.getState().activeModal).toBe('quick-open')
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

  it('performs one bounded notification per transition under repeated replacement', () => {
    const store = createUIStore()
    const dismissed = new Set<number>()
    const transitionCount = 1_000

    for (let id = 0; id < transitionCount; id += 1) {
      store.getState().openModal(
        'worktree-palette',
        dismissalData(() => {
          expect(dismissed.has(id)).toBe(false)
          dismissed.add(id)
        })
      )
    }
    store.getState().closeModal()

    expect(dismissed.size).toBe(transitionCount)
    expect(store.getState().modalData).toEqual({})
  })
})
