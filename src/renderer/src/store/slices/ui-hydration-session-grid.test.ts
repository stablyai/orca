import { describe, expect, it } from 'vitest'
import { SESSION_GRID_ZOOM_MAX, SESSION_GRID_ZOOM_MIN } from './session-grid-zoom'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('session grid hydration', () => {
  it('keeps an unflushed local reorder when a sync broadcast carries the stale disk order', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridTabOrder: ['a', 'b'] }), 'startup')
    expect(store.getState().sessionsGridTabOrder).toEqual(['a', 'b'])

    // The user drags; the debounced writer has not flushed yet. Then main
    // broadcasts — a window resize persists windowBounds and re-emits the
    // whole UI state — with the order still as it was on disk.
    store.getState().setSessionsGridTabOrder(['b', 'a'])
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridTabOrder: ['a', 'b'] }), 'sync')

    expect(store.getState().sessionsGridTabOrder).toEqual(['b', 'a'])
  })

  it('keeps the order array identity when the broadcast carries the same order', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ sessionsGridTabOrder: ['a', 'b'], sidebarWidth: 300 }),
        'startup'
      )
    const before = store.getState().sessionsGridTabOrder

    // Why a moving sidebarWidth: hydratePersistedUI short-circuits and returns the same
    // state when the WHOLE hydrated partial matches by value, which would preserve the
    // identity on its own. Another field in the same broadcast — a sidebar drag riding
    // the same sync — forces the set(), so the identity guard is the only thing left.
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ sessionsGridTabOrder: ['a', 'b'], sidebarWidth: 320 }),
        'sync'
      )

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().sessionsGridTabOrder).toBe(before)
  })

  it('ignores a preset, scroll mode, wheel target or state filter the layout has no case for', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        sessionsGridPreset: '9x9',
        sessionsGridScrollMode: 'smooth',
        sessionsGridWheelTarget: 'mouse',
        sessionsGridStateFilter: 'blocked'
      } as never),
      'startup'
    )
    expect(store.getState().sessionsGridPreset).toBe('2x2')
    expect(store.getState().sessionsGridScrollMode).toBe('row')
    expect(store.getState().sessionsGridWheelTarget).toBe('auto')
    expect(store.getState().sessionsGridStateFilter).toBe('all')
  })

  it('takes a persisted wheel target', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridWheelTarget: 'grid' }), 'startup')
    expect(store.getState().sessionsGridWheelTarget).toBe('grid')
  })

  it('dedupes a persisted order', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridTabOrder: ['a', 'a', 'b'] }), 'startup')
    expect(store.getState().sessionsGridTabOrder).toEqual(['a', 'b'])
  })
})

describe('session grid state filter hydration', () => {
  it('keeps an unflushed local pick when a sync broadcast carries the stale disk value', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridStateFilter: 'attention' }), 'startup')

    // The user picks another bucket; the debounced writer has not flushed yet,
    // then main re-broadcasts the whole UI state as it still is on disk.
    store.getState().setSessionsGridStateFilter('working')
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridStateFilter: 'attention' }), 'sync')

    expect(store.getState().sessionsGridStateFilter).toBe('working')
  })

  it('takes a persisted state filter, and a same-value broadcast leaves it alone', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridStateFilter: 'done' }), 'startup')
    expect(store.getState().sessionsGridStateFilter).toBe('done')

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridStateFilter: 'done' }), 'sync')
    expect(store.getState().sessionsGridStateFilter).toBe('done')
  })

  it('ignores a state filter the grid has no bucket for', () => {
    const store = createUIStore()
    store.getState().setSessionsGridStateFilter('idle')
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridStateFilter: 'blocked' } as never), 'sync')
    expect(store.getState().sessionsGridStateFilter).toBe('idle')
  })
})

describe('session grid hidden tabs hydration', () => {
  it('keeps an unflushed local hide when a sync broadcast carries the stale disk list', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridHiddenTabIds: ['a'] }), 'startup')
    expect(store.getState().sessionsGridHiddenTabIds).toEqual(['a'])

    store.getState().toggleSessionsGridHiddenTab('b')
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridHiddenTabIds: ['a'] }), 'sync')

    expect(store.getState().sessionsGridHiddenTabIds).toEqual(['a', 'b'])
  })

  it('keeps the hidden array identity when the broadcast carries the same list', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ sessionsGridHiddenTabIds: ['a', 'b'], sidebarWidth: 300 }),
        'startup'
      )
    const before = store.getState().sessionsGridHiddenTabIds

    // Same reason as the order test above: without a field that actually moves, the
    // whole-partial value match short-circuits the set() and nothing exercises the guard.
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ sessionsGridHiddenTabIds: ['a', 'b'], sidebarWidth: 320 }),
        'sync'
      )

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().sessionsGridHiddenTabIds).toBe(before)
  })

  it('ignores a hidden list that is not an array', () => {
    const store = createUIStore()
    store.getState().toggleSessionsGridHiddenTab('a')
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sessionsGridHiddenTabIds: 'a' } as never), 'sync')
    expect(store.getState().sessionsGridHiddenTabIds).toEqual(['a'])
  })

  it('sanitizes a persisted hidden list: dupes and non-strings go', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ sessionsGridHiddenTabIds: ['a', 'a', 7, '', 'b'] } as never),
        'startup'
      )
    expect(store.getState().sessionsGridHiddenTabIds).toEqual(['a', 'b'])
  })

  it('toggles one tab without disturbing the rest', () => {
    const store = createUIStore()
    store.getState().setSessionsGridHiddenTabIds(['a', 'b', 'c'])
    store.getState().toggleSessionsGridHiddenTab('b')
    expect(store.getState().sessionsGridHiddenTabIds).toEqual(['a', 'c'])
  })
})

describe('session grid zoom hydration', () => {
  it('clamps a persisted zoom to the slider range, like the setter does', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI({ sessionsGridZoom: 4 }), 'startup')
    expect(store.getState().sessionsGridZoom).toBe(SESSION_GRID_ZOOM_MAX)
    store.getState().hydratePersistedUI(makePersistedUI({ sessionsGridZoom: 0.1 }), 'sync')
    expect(store.getState().sessionsGridZoom).toBe(SESSION_GRID_ZOOM_MIN)
    store.getState().hydratePersistedUI(makePersistedUI({ sessionsGridZoom: 1.1 }), 'sync')
    expect(store.getState().sessionsGridZoom).toBe(1.1)
  })

  it('ignores a non-finite zoom', () => {
    const store = createUIStore()
    store.getState().setSessionsGridZoom(1.2)
    store.getState().hydratePersistedUI(makePersistedUI({ sessionsGridZoom: Number.NaN }), 'sync')
    expect(store.getState().sessionsGridZoom).toBe(1.2)
  })
})
