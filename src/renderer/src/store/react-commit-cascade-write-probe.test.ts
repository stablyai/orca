import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { withReactCommitCascadeWriteProbe } from './react-commit-cascade-write-probe'
import type { ReactCommitCascadeWriteBoundary } from '@/lib/react-commit-cascade-store-write-samples'

const { probe, noteWrite } = vi.hoisted(() => ({
  probe: { armed: false },
  noteWrite: vi.fn()
}))
vi.mock('@/lib/react-commit-cascade-store-write-samples', () => ({
  reactCommitCascadeWriteProbe: probe,
  noteReactCommitCascadeStoreWrite: (boundary: ReactCommitCascadeWriteBoundary, partial: unknown) =>
    noteWrite(boundary, partial)
}))

type ProbedState = { ticks: number; label?: string }

function createProbedStore(): UseBoundStore<StoreApi<ProbedState>> {
  return create<ProbedState>()(
    withReactCommitCascadeWriteProbe<ProbedState>(() => ({ ticks: 0, label: 'initial' }))
  )
}

beforeEach(() => {
  probe.armed = false
  noteWrite.mockReset()
})

describe('withReactCommitCascadeWriteProbe', () => {
  // Diagnostics wrap every write; throwing would drop app state.
  it('lands the write even when the sampler throws', () => {
    noteWrite.mockImplementation(() => {
      throw new Error('sampler exploded')
    })
    const useProbedStore = createProbedStore()
    probe.armed = true

    expect(() => useProbedStore.setState({ ticks: 3 })).not.toThrow()
    expect(useProbedStore.getState().ticks).toBe(3)
  })
})
