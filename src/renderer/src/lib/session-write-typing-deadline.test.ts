import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'

let original: AppState
let cleanup: (() => void) | undefined
beforeEach(() => {
  original = useAppStore.getState()
  vi.useFakeTimers()
  useAppStore.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    openFiles: [
      {
        id: 'note',
        filePath: '/repo/note.txt',
        relativePath: 'note.txt',
        worktreeId: 'wt',
        language: 'plaintext',
        mode: 'edit',
        isDirty: true
      }
    ],
    editorDrafts: { note: 'initial' }
  })
})
afterEach(() => {
  cleanup?.()
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

describe('compatibility snapshot typing deadline', () => {
  it('writes fresh drafts at least once a second throughout typing without a quiet interval', () => {
    const persist = vi.fn<(write: WorkspaceSessionWrite) => void>()
    cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })
    for (let index = 0; index < 30; index++) {
      useAppStore.getState().setEditorDraft('note', `text-${index}`)
      vi.advanceTimersByTime(100)
    }
    expect(persist).toHaveBeenCalledTimes(3)
    expect(
      persist.mock.calls.at(-1)?.[0].patch.openFilesByWorktree?.wt?.[0]?.dirtyDraftContent
    ).toBe('text-29')
  })

  it('keeps an overdue draft and writes it immediately when a suppression gate reopens', () => {
    let allowed = true
    let wake: (() => void) | undefined
    const persist = vi.fn<(write: WorkspaceSessionWrite) => void>()
    cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => allowed,
      subscribeToPersistGateOpen: (listener) => {
        wake = listener
        return () => {
          wake = undefined
        }
      }
    })
    useAppStore.getState().setEditorDraft('note', 'latest behind gate')
    allowed = false
    vi.advanceTimersByTime(5_000)
    expect(persist).not.toHaveBeenCalled()
    allowed = true
    wake?.()
    vi.advanceTimersByTime(0)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0]?.[0].patch.openFilesByWorktree?.wt?.[0]?.dirtyDraftContent).toBe(
      'latest behind gate'
    )
  })
})
