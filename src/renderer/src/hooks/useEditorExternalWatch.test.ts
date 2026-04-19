import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import type { FsChangedPayload } from '../../../shared/types'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
// Why: editor-autosave calls window.dispatchEvent at module scope paths; the
// vitest 'node' environment has no window. Stub the two exports we use so the
// handler can run headlessly.
vi.mock('@/components/editor/editor-autosave', () => ({
  notifyEditorExternalFileChange: vi.fn(),
  getOpenFilesForExternalFileChange: vi.fn(() => [])
}))

import {
  createExternalWatchEventHandler,
  getOverflowExternalReloadTargets
} from './useEditorExternalWatch'
import { useAppStore } from '@/store'

describe('getOverflowExternalReloadTargets', () => {
  const setExternalMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears tombstones and reloads clean edit tabs on overflow', () => {
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'notes.md',
          mode: 'edit',
          isDirty: false,
          externalMutation: 'deleted'
        },
        {
          id: 'file-2',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'dirty.md',
          mode: 'edit',
          isDirty: true
        },
        {
          id: 'file-3',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'staged.ts',
          mode: 'diff',
          diffSource: 'staged',
          isDirty: false
        }
      ],
      setExternalMutation
    } as never)

    expect(
      getOverflowExternalReloadTargets({
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      })
    ).toEqual([
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        relativePath: 'notes.md'
      }
    ])
    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)
  })
})

describe('createExternalWatchEventHandler tombstone coalescing', () => {
  const setExternalMutation = vi.fn()
  const findTarget = (
    worktreePath: string
  ):
    | {
        worktreeId: string
        worktreePath: string
        connectionId: string | undefined
      }
    | undefined =>
    worktreePath === '/repo'
      ? { worktreeId: 'wt-1', worktreePath: '/repo', connectionId: undefined }
      : undefined

  const fileNotes = {
    id: 'file-notes',
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    mode: 'edit' as const,
    isDirty: false
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [fileNotes],
      setExternalMutation
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function payload(events: FsChangedPayload['events']): FsChangedPayload {
    return { worktreePath: '/repo', events }
  }

  it('does not flash deleted when a create at the same path arrives in the next payload', () => {
    // Simulates macOS atomic write: two back-to-back payloads, delete then create.
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))

    // Advance less than the debounce window; the deleted tombstone must not
    // have fired yet.
    vi.advanceTimersByTime(10)
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')

    handleFsChanged(payload([{ kind: 'create', absolutePath: '/repo/notes.md' }]))

    // Flush anything remaining; the pending tombstone should have been cancelled.
    vi.advanceTimersByTime(500)
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')

    dispose()
  })

  it('still sets deleted after the debounce window for a naked delete', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))

    expect(setExternalMutation).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'deleted')

    dispose()
  })

  it('resolves batched delete+create in a single payload synchronously as renamed', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(
      payload([
        { kind: 'delete', absolutePath: '/repo/notes.md' },
        { kind: 'create', absolutePath: '/repo/subdir/notes.md' }
      ])
    )

    // The single-payload rename-correlated path must not defer — the decision
    // is already correct because both events are visible at once.
    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'renamed')

    dispose()
  })
})
