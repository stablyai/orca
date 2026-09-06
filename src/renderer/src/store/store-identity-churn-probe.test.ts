import { beforeEach, describe, expect, it } from 'vitest'
import { create } from 'zustand'
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
