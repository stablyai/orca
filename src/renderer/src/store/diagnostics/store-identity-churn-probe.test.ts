import { beforeEach, describe, expect, it } from 'vitest'
import { create } from 'zustand'
import './react-commit-cascade-write-probe'
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
})
