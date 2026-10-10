import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi } from 'zustand'
import { withReactCommitCascadeWriteProbe } from './react-commit-cascade-write-probe'
import {
  armStoreIdentityChurnProbe,
  disarmStoreIdentityChurnProbe,
  readStoreIdentityChurnReport,
  withStoreIdentityChurnProbe
} from './store-identity-churn-probe'

type ProbeState = {
  rows: { id: string; label: string }[]
  entries: Record<string, { status: string }>
  counter: number
  refresh: (rows: { id: string; label: string }[]) => void
  touch: (id: string, status: string) => void
  bump: () => void
}

function createProbeStore() {
  return create<ProbeState>()(
    withStoreIdentityChurnProbe((set) => ({
      rows: [{ id: 'a', label: 'A' }],
      entries: { a: { status: 'idle' } },
      counter: 0,
      refresh: (rows) => set({ rows }),
      touch: (id, status) => set((state) => ({ entries: { ...state.entries, [id]: { status } } })),
      bump: () => set((state) => ({ counter: state.counter + 1 }))
    }))
  )
}

function churnFor(field: string): number {
  return readStoreIdentityChurnReport().find((row) => row.field === field)?.churnedWrites ?? 0
}

describe('store identity churn probe', () => {
  beforeEach(() => {
    // Arming resets the counters; disarming immediately leaves a clean, off probe.
    armStoreIdentityChurnProbe()
    disarmStoreIdentityChurnProbe()
  })

  it('flags a refresh that rebuilds an array with unchanged contents', () => {
    const store = createProbeStore()
    armStoreIdentityChurnProbe()

    store.getState().refresh([{ id: 'a', label: 'A' }])

    expect(churnFor('rows')).toBe(1)
    expect(readStoreIdentityChurnReport()[0]).toMatchObject({
      field: 'rows',
      churnedWrites: 1,
      replacedWrites: 1,
      sites: []
    })
  })

  it('flags a keyed update that rewrites an entry with the same value', () => {
    const store = createProbeStore()
    armStoreIdentityChurnProbe()

    store.getState().touch('a', 'idle')

    expect(churnFor('entries')).toBe(1)
  })

  it('does not flag writes that change the value', () => {
    const store = createProbeStore()
    armStoreIdentityChurnProbe()

    store.getState().refresh([{ id: 'a', label: 'B' }])
    store.getState().touch('a', 'running')
    store.getState().bump()

    expect(readStoreIdentityChurnReport()).toEqual([])
  })

  it('does not flag a refresh that returns the original reference', () => {
    const store = createProbeStore()
    const original = store.getState().rows
    armStoreIdentityChurnProbe()

    store.getState().refresh(original)

    expect(readStoreIdentityChurnReport()).toEqual([])
  })

  it('names the write site when capture is requested', () => {
    const store = createProbeStore()
    armStoreIdentityChurnProbe({ captureSites: true })

    store.getState().refresh([{ id: 'a', label: 'A' }])

    const [row] = readStoreIdentityChurnReport()
    expect(row.sites).toHaveLength(1)
    expect(row.sites[0]).toMatchObject({ churnedWrites: 1 })
    expect(row.sites[0].site).toContain('store-identity-churn-probe.test')
  })

  it('leaves a functional updater to zustand: called once, with the live state', () => {
    const store = createProbeStore()
    const seen: unknown[] = []
    armStoreIdentityChurnProbe()

    store.setState((state) => {
      seen.push(state)
      return { counter: state.counter + 1 }
    })
    store.setState((state) => {
      seen.push(state)
      return { rows: [{ ...state.rows[0] }] }
    })

    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ counter: 1 })
    expect(store.getState().counter).toBe(1)
    expect(churnFor('rows')).toBe(1)
  })

  it('ignores a write zustand itself drops as identical', () => {
    const store = createProbeStore()
    armStoreIdentityChurnProbe()

    store.setState((state) => state)

    expect(readStoreIdentityChurnReport()).toEqual([])
  })

  it('passes disarmed writes straight through without reading state', () => {
    const innerSet = vi.fn()
    const innerGet = vi.fn(() => ({ counter: 0 }))
    const api = { setState: innerSet, getState: innerGet } as unknown as StoreApi<{
      counter: number
    }>
    const creator = withStoreIdentityChurnProbe<{ counter: number }>(() => ({ counter: 0 }))
    creator(innerSet, innerGet, api)
    const updater = (state: { counter: number }) => ({ counter: state.counter + 1 })

    api.setState(updater, true)

    // The disarmed path forwards the exact arguments and never calls get().
    expect(innerSet).toHaveBeenCalledTimes(1)
    expect(innerSet.mock.calls[0]).toEqual([updater, true])
    expect(innerGet).not.toHaveBeenCalled()
  })

  it('composes with the cascade probe without dropping or doubling a write', () => {
    // Mirrors store/index.ts: churn probe outermost, cascade probe inside it.
    const store = create<ProbeState>()(
      withStoreIdentityChurnProbe(
        withReactCommitCascadeWriteProbe((set) => ({
          rows: [{ id: 'a', label: 'A' }],
          entries: { a: { status: 'idle' } },
          counter: 0,
          refresh: (rows) => set({ rows }),
          touch: (id, status) =>
            set((state) => ({ entries: { ...state.entries, [id]: { status } } })),
          bump: () => set((state) => ({ counter: state.counter + 1 }))
        }))
      )
    )
    let updaterCalls = 0
    armStoreIdentityChurnProbe({ captureSites: true })

    store.getState().bump()
    store.setState((state) => {
      updaterCalls += 1
      return { counter: state.counter + 10 }
    })
    store.getState().refresh([{ id: 'a', label: 'A' }])
    store.setState({ ...store.getState(), counter: 100 }, true)

    expect(updaterCalls).toBe(1)
    expect(store.getState().counter).toBe(100)
    expect(store.getState().rows).toEqual([{ id: 'a', label: 'A' }])
    // The named site is this test, not the sibling probe's wrapper frame.
    const [row] = readStoreIdentityChurnReport()
    expect(row).toMatchObject({ field: 'rows', churnedWrites: 1 })
    expect(row.sites[0].site).toContain('store-identity-churn-probe.test')
  })

  it('still sees churn on a replace write', () => {
    const store = createProbeStore()
    const rows = store.getState().rows
    armStoreIdentityChurnProbe()

    store.setState({ ...store.getState(), rows: [{ ...rows[0] }] }, true)

    expect(churnFor('rows')).toBe(1)
  })

  it('records nothing while disarmed', () => {
    const store = createProbeStore()

    store.getState().refresh([{ id: 'a', label: 'A' }])

    expect(readStoreIdentityChurnReport()).toEqual([])
  })

  it('treats distinct class instances as changed rather than equal', () => {
    const store = create<{ value: unknown; put: (value: unknown) => void }>()(
      withStoreIdentityChurnProbe((set) => ({
        value: new Map([['a', 1]]),
        put: (value) => set({ value })
      }))
    )
    armStoreIdentityChurnProbe()

    store.getState().put(new Map([['a', 1]]))

    expect(readStoreIdentityChurnReport()).toEqual([])
  })
})
