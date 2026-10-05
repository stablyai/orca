import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import type { EditorRecoveryApi } from '../../../shared/editor-recovery'
import { registerEditorModelContentCheckpoint } from '@/components/editor/editor-model-content-checkpoint'
import { createCheckpointModelFixture } from '@/components/editor/editor-model-checkpoint-test-fixture'
import { createEditorRecoverySubscriber } from './editor-recovery-subscriber'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'

let original: AppState
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  original = useAppStore.getState()
  useAppStore.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    openFiles: [
      {
        id: 'model-note',
        filePath: '/repo/note.txt',
        relativePath: 'note.txt',
        worktreeId: 'wt',
        language: 'plaintext',
        mode: 'edit',
        isDirty: false
      }
    ],
    editorDrafts: {}
  })
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  useAppStore.setState(original, true)
  vi.useRealTimers()
})
function fixture() {
  const model = createCheckpointModelFixture()
  const appliedAt: number[] = []
  const apply = vi.fn<EditorRecoveryApi['apply']>(async (changes) => {
    appliedAt.push(Date.now())
    return changes.map((change) => ({ id: change.id, revision: change.expectedRevision + 1 }))
  })
  const recovery = createEditorRecoverySubscriber({
    store: useAppStore,
    api: { apply, list: async () => [], read: async () => null, export: async () => null },
    onError: (error) => {
      throw error
    },
    flushPendingChanges: () => {}
  })
  const persist = vi.fn<(write: WorkspaceSessionWrite) => void>()
  cleanups.push(
    registerEditorModelContentCheckpoint(model.model, {
      fileId: 'model-note',
      publish: (content) => {
        useAppStore.getState().setEditorDraft('model-note', content)
        useAppStore.getState().markFileDirty('model-note', content !== 'baseline')
      },
      onPending: () => useAppStore.getState().markFileDirty('model-note', true)
    }),
    recovery.dispose,
    createSessionWriteSubscriber({ store: useAppStore, persist })
  )
  return { model, recovery, apply, appliedAt, persist }
}

describe('persistence driven by model notifications', () => {
  it('keeps journal and compatibility deadlines measured from input during continuous typing', async () => {
    const f = fixture()
    for (let index = 0; index < 30; index++) {
      f.model.edit(`input-${index}`)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(f.appliedAt).toHaveLength(6)
    for (let index = 1; index < f.appliedAt.length; index++) {
      expect(f.appliedAt[index] - f.appliedAt[index - 1]).toBeLessThanOrEqual(500)
    }
    expect(f.apply.mock.calls.at(-1)?.[0][0]).toMatchObject({
      content: 'input-29',
      state: 'active'
    })
    expect(f.persist).toHaveBeenCalledTimes(3)
    expect(
      f.persist.mock.calls.at(-1)?.[0].patch.openFilesByWorktree?.wt?.[0]?.dirtyDraftContent
    ).toBe('input-29')
    expect(f.model.model.getValue).toHaveBeenCalledTimes(6)
    const writes = f.apply.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.apply).toHaveBeenCalledTimes(writes)
  })

  it('retains the last input when closing before any materialization timer fires', async () => {
    const f = fixture()
    f.model.edit('last input before close')
    expect(f.model.model.getValue).not.toHaveBeenCalled()
    useAppStore.getState().closeFile('model-note')
    await f.recovery.flush()
    expect(f.apply.mock.calls.flatMap(([changes]) => changes)).toEqual([
      expect.objectContaining({
        kind: 'put',
        content: 'last input before close',
        state: 'retained'
      })
    ])
    expect(useAppStore.getState().openFiles).toEqual([])
  })

  it('flushes the latest body when a compatibility write gate reopens after its deadline', () => {
    const f = fixture()
    // Keep this case isolated from the journal's earlier 500ms checkpoint.
    f.recovery.dispose()
    cleanups.pop()?.()
    let allowed = false
    let wake: (() => void) | undefined
    cleanups.push(
      createSessionWriteSubscriber({
        store: useAppStore,
        persist: f.persist,
        shouldSchedulePersist: () => allowed,
        subscribeToPersistGateOpen: (listener) => {
          wake = listener
          return () => {
            wake = undefined
          }
        }
      })
    )
    f.model.edit('pending behind gate')
    vi.advanceTimersByTime(5_000)
    expect(f.persist).not.toHaveBeenCalled()
    f.model.edit('newest just before gate opens')
    allowed = true
    wake?.()
    vi.advanceTimersByTime(150)
    expect(
      f.persist.mock.calls.at(-1)?.[0].patch.openFilesByWorktree?.wt?.[0]?.dirtyDraftContent
    ).toBe('newest just before gate opens')
  })
})
