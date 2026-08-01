/**
 * The census used to wrap `subscribe` on the bound hook AFTER create() ran. zustand's
 * useStore() reads the inner api.subscribe, so that version counted only imperative
 * subscribers and missed every React hook subscription — the ones that actually scale
 * with agent rows. These tests pin both paths.
 */
import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { collectRendererMemoryProfileCounts } from '../lib/renderer-memory-profile'
import { installStoreListenerCensus, readStoreListenerCount } from './store-listener-census'

type CensusState = { n: number }
type CensusApi = {
  subscribe: (listener: (state: CensusState, previous: CensusState) => void) => () => void
  setState: (partial: Partial<CensusState>) => void
}

/** Rebuilds what zustand's create() does, so the test exercises the real wiring order. */
function createCensusStore(): { api: CensusApi; hook: { subscribe: unknown } } {
  const api = createStore<CensusState>(() => ({ n: 0 })) as unknown as CensusApi
  installStoreListenerCensus(api)
  const hook = ((selector: (state: CensusState) => unknown) =>
    useStore(api as never, selector)) as unknown as { subscribe: unknown }
  Object.assign(hook, api)
  return { api, hook }
}

describe('store listener census', () => {
  it('counts subscriptions made through the inner api, which is what React useStore uses', () => {
    const { api } = createCensusStore()
    const baseline = readStoreListenerCount() ?? -1
    expect(baseline).toBe(0)

    const unsubscribe = api.subscribe(() => undefined)
    expect(readStoreListenerCount()).toBe(1)

    unsubscribe()
    expect(readStoreListenerCount()).toBe(0)
  })

  it('counts subscriptions made through the hook copy that create() assigns', () => {
    const { hook } = createCensusStore()
    const subscribe = hook.subscribe as (listener: () => void) => () => void

    const unsubscribe = subscribe(() => undefined)
    expect(readStoreListenerCount()).toBe(1)

    unsubscribe()
    expect(readStoreListenerCount()).toBe(0)
  })

  it('counts the hook copy and the inner api as the same pool', () => {
    const { api, hook } = createCensusStore()
    const subscribe = hook.subscribe as (listener: () => void) => () => void

    const viaHook = subscribe(() => undefined)
    const viaApi = api.subscribe(() => undefined)
    expect(readStoreListenerCount()).toBe(2)

    viaHook()
    viaApi()
    expect(readStoreListenerCount()).toBe(0)
  })

  it('does not double-decrement when React calls the same cleanup twice', () => {
    const { api } = createCensusStore()
    const keep = api.subscribe(() => undefined)
    const unsubscribe = api.subscribe(() => undefined)
    expect(readStoreListenerCount()).toBe(2)

    unsubscribe()
    unsubscribe()
    expect(readStoreListenerCount()).toBe(1)

    keep()
    expect(readStoreListenerCount()).toBe(0)
  })

  it('reports the live count into the renderer memory profile', () => {
    // Why: the count was already computed and then discarded. OOM crash reports
    // need it to tell a subscriber leak apart from a data leak.
    const { api } = createCensusStore()
    const unsubscribe = api.subscribe(() => undefined)

    expect(collectRendererMemoryProfileCounts()).toMatchObject({ 'storeSubscribers.live': 1 })

    unsubscribe()
    expect(collectRendererMemoryProfileCounts()).toMatchObject({ 'storeSubscribers.live': 0 })
  })

  it('still delivers state updates to a counted listener', () => {
    const { api } = createCensusStore()
    let seen = 0
    const unsubscribe = api.subscribe((state) => {
      seen = state.n
    })

    api.setState({ n: 7 })
    expect(seen).toBe(7)

    unsubscribe()
    api.setState({ n: 9 })
    expect(seen).toBe(7)
  })
})
