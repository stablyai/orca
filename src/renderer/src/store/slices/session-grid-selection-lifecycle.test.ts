import { describe, expect, it } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

/**
 * The grid's selected card is what `useAutoAckViewedAgent` treats as "the user is looking at
 * this one", and a sighting clears that agent's signal on five surfaces at once. So the
 * selection has to stop being valid the moment the card stops being on the board — otherwise
 * a selection from a previous visit acks a turn that happened while nobody was watching.
 */
describe('the session grid selection outlives nothing', () => {
  it('starts an explicit reopen with nothing selected, even while already on the grid', () => {
    const store = createUIStore()
    store.getState().openSessionsPage()
    store.getState().setActiveSessionGridTabId('tab-a')
    store.getState().openSessionsPage()
    expect(store.getState().activeSessionGridTabId).toBeNull()
  })

  it('clears history selections atomically on generic view transitions', () => {
    const store = createUIStore()
    store.getState().openSessionsPage()
    store.getState().setActiveSessionGridTabId('tab-a')
    const selections: (string | null)[] = []
    store.subscribe((state) => selections.push(state.activeSessionGridTabId))
    store.getState().setActiveView('terminal')
    store.getState().setActiveView('sessions')
    expect(selections).toEqual([null, null])
  })

  it('clears selection when another page returns to its previous sessions view', () => {
    const store = createUIStore()
    store.getState().openSessionsPage()
    store.getState().setActiveSessionGridTabId('tab-a')
    store.getState().openMobilePage()
    expect(store.getState().activeSessionGridTabId).toBeNull()
    store.getState().closeMobilePage()
    expect(store.getState().activeView).toBe('sessions')
    expect(store.getState().activeSessionGridTabId).toBeNull()
  })

  it('starts each visit to the grid with nothing selected', () => {
    const store = createUIStore()
    store.getState().setActiveSessionGridTabId('tab-a')

    store.getState().openSessionsPage()

    expect(store.getState().activeSessionGridTabId).toBeNull()
  })

  // The failure this closes: select A, leave, A finishes, come back — and A is acked on
  // arrival, before the user has seen anything.
  it('drops the selection on the way out, so returning does not ack it', () => {
    const store = createUIStore()
    store.getState().openSessionsPage()
    store.getState().setActiveSessionGridTabId('tab-a')

    store.getState().closeSessionsPage()

    expect(store.getState().activeSessionGridTabId).toBeNull()
  })

  it('drops the selection when either filter axis re-queries the board', () => {
    const store = createUIStore()
    store.getState().setActiveSessionGridTabId('tab-a')
    store.getState().setSessionsGridFilter('wt-2')
    expect(store.getState().activeSessionGridTabId).toBeNull()

    store.getState().setActiveSessionGridTabId('tab-a')
    store.getState().setSessionsGridStateFilter('idle')
    expect(store.getState().activeSessionGridTabId).toBeNull()
  })

  it('drops the selection when its own card is hidden from the grid', () => {
    const store = createUIStore()
    store.getState().setActiveSessionGridTabId('tab-a')

    store.getState().toggleSessionsGridHiddenTab('tab-a')

    expect(store.getState().sessionsGridHiddenTabIds).toEqual(['tab-a'])
    expect(store.getState().activeSessionGridTabId).toBeNull()
  })

  it('keeps the selection when another card is hidden, or when its own is shown again', () => {
    const store = createUIStore()
    store.getState().toggleSessionsGridHiddenTab('tab-a')
    store.getState().setActiveSessionGridTabId('tab-a')

    // Revealing, the user shows tab-a again: the card stays on the board, and so does the ring.
    store.getState().toggleSessionsGridHiddenTab('tab-a')
    expect(store.getState().activeSessionGridTabId).toBe('tab-a')

    store.getState().toggleSessionsGridHiddenTab('tab-b')
    expect(store.getState().activeSessionGridTabId).toBe('tab-a')
  })

  it('drops the selection when a bulk hidden-list write buries its card', () => {
    const store = createUIStore()
    store.getState().setActiveSessionGridTabId('tab-a')

    store.getState().setSessionsGridHiddenTabIds(['tab-a', 'tab-b'])

    expect(store.getState().activeSessionGridTabId).toBeNull()
  })
})
