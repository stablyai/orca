import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { withReactCommitCascadeWriteProbe } from './react-commit-cascade-write-probe'
import { withEditorBufferRecords } from './editor-buffer-record-lifecycle'
import type { EditorBufferRecords } from './slices/editor/buffers/editor-buffer-record'
import type { OpenFile } from './slices/editor/types/open-file'
import type { ReactCommitCascadeWriteBoundary } from '@/lib/react-commit-cascade-store-write-samples'
import {
  EMPTY_EDITOR_BUFFER_VIEW_INDEX,
  type EditorBufferViewIndex
} from './slices/editor/buffers/editor-buffer-views'

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
  // Why this matters most: this wraps every write the app makes. A diagnostic
  // that throws here would drop the write and take app state with it.
  it('lands the write even when the sampler throws', () => {
    noteWrite.mockImplementation(() => {
      throw new Error('sampler exploded')
    })
    const useProbedStore = createProbedStore()
    probe.armed = true

    expect(() => useProbedStore.setState({ ticks: 3 })).not.toThrow()
    expect(useProbedStore.getState().ticks).toBe(3)
  })

  // Why asserted: create() copies api.setState onto the hook AFTER the creator
  // runs, so a middleware that forgets this line leaves store.setState unprobed.
  it('routes the api setState through the probe', () => {
    const useProbedStore = createProbedStore()
    probe.armed = true

    useProbedStore.setState({ ticks: 1 })

    expect(noteWrite).toHaveBeenCalledTimes(1)
    // The boundary must be the wrapper itself, so V8 elides it from the sample.
    expect(noteWrite.mock.calls[0]?.[0]).toBe(useProbedStore.setState)
    expect(noteWrite.mock.calls[0]?.[1]).toEqual({ ticks: 1 })
  })

  it('passes the replace flag through', () => {
    const useProbedStore = createProbedStore()
    probe.armed = true

    useProbedStore.setState({ ticks: 2 }, true)

    expect(useProbedStore.getState()).toEqual({ ticks: 2 })
  })

  it('costs nothing but a flag read while unarmed', () => {
    const useProbedStore = createProbedStore()

    useProbedStore.setState({ ticks: 4 })

    expect(noteWrite).not.toHaveBeenCalled()
    expect(useProbedStore.getState().ticks).toBe(4)
  })

  // Why: composed as in store/index.ts, the buffer middleware must not turn every write into one
  // updater from one frame, or the crash report loses changed keys and distinct write sites.
  it('sees each original partial and caller under the editor buffer middleware', () => {
    type BufferedState = EditorBufferViewIndex & {
      ticks: number
      openFiles: OpenFile[]
      editorBuffers: EditorBufferRecords
      tick: () => void
    }
    const useBufferedStore = create<BufferedState>()(
      withEditorBufferRecords(
        withReactCommitCascadeWriteProbe<BufferedState>((set) => ({
          ticks: 0,
          openFiles: [],
          editorBuffers: {},
          ...EMPTY_EDITOR_BUFFER_VIEW_INDEX,
          tick: () => set({ ticks: 1 })
        }))
      )
    )
    probe.armed = true

    useBufferedStore.getState().tick()
    useBufferedStore.setState({ ticks: 2 })

    expect(noteWrite.mock.calls.map(([, partial]) => partial)).toEqual([{ ticks: 1 }, { ticks: 2 }])
    expect(noteWrite.mock.calls[1]?.[0]).toBe(useBufferedStore.setState)
    expect(useBufferedStore.getState().ticks).toBe(2)
  })
})
