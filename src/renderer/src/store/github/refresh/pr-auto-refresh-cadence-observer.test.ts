import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  getPRAutoRefreshCadence,
  setPRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
import { installPRAutoRefreshCadenceObserver } from './pr-auto-refresh-cadence-observer'

type State = { settings: Pick<GlobalSettings, 'prAutoRefresh'> | null }

function fakeStore(initial: State) {
  let state = initial
  const listeners = new Set<(next: State, previous: State) => void>()
  return {
    getState: () => state,
    subscribe: (listener: (next: State, previous: State) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: State) {
      const previous = state
      state = next
      for (const listener of listeners) {
        listener(state, previous)
      }
    }
  }
}

describe('installPRAutoRefreshCadenceObserver', () => {
  afterEach(() => {
    setPRAutoRefreshCadence('default')
  })

  it('applies the loaded setting and follows later changes', () => {
    const store = fakeStore({ settings: null })
    installPRAutoRefreshCadenceObserver(store)
    expect(getPRAutoRefreshCadence()).toBe('default')

    store.set({ settings: { prAutoRefresh: 'minimal' } })
    expect(getPRAutoRefreshCadence()).toBe('minimal')

    store.set({ settings: { prAutoRefresh: 'off' } })
    expect(getPRAutoRefreshCadence()).toBe('off')
  })
})
