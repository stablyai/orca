import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type * as Autosave from '@/components/editor/editor-autosave'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import { notifyEditorExternalFileChange } from '@/components/editor/editor-autosave'

const state = vi.hoisted(
  (): {
    openFiles: OpenFile[]
    setExternalMutation: ReturnType<typeof vi.fn>
  } => ({ openFiles: [], setExternalMutation: vi.fn() })
)
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof Autosave>()),
  notifyEditorExternalFileChange: vi.fn()
}))

function file(worktreeId: string, isDirty = false): OpenFile {
  return {
    id: `${worktreeId}:notes.md`,
    filePath: '/shared/notes.md',
    relativePath: 'notes.md',
    worktreeId,
    language: 'markdown',
    mode: 'edit',
    isDirty
  }
}

const targets = ['first', 'second'].map((worktreeId) => ({
  worktreeId,
  worktreePath: '/shared',
  connectionId: undefined,
  runtimeEnvironmentId: null
}))

describe('external changes for shared editor roots', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    state.openFiles = [file('first'), file('second')]
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reloads both clean owners and dispatches the workspace event once', () => {
    const handler = buildEditorExternalWatchEventHandler(() => targets)
    handler.handleFsChanged({
      worktreePath: '/shared',
      events: [{ kind: 'update', absolutePath: '/shared/notes.md' }]
    })
    vi.advanceTimersByTime(100)
    expect(notifyEditorExternalFileChange).toHaveBeenCalledTimes(2)
    for (const target of targets) {
      expect(notifyEditorExternalFileChange).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: target.worktreeId,
          worktreePath: target.worktreePath,
          runtimeEnvironmentId: target.runtimeEnvironmentId
        })
      )
    }
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1)
    handler.dispose()
  })

  it('preserves a dirty draft while reloading the clean mirror', () => {
    state.openFiles = [file('first', true), file('second')]
    const handler = buildEditorExternalWatchEventHandler(() => targets)
    handler.handleFsChanged({
      worktreePath: '/shared',
      events: [{ kind: 'update', absolutePath: '/shared/notes.md' }]
    })
    vi.advanceTimersByTime(100)
    expect(state.setExternalMutation).toHaveBeenCalledExactlyOnceWith('first:notes.md', 'changed')
    expect(notifyEditorExternalFileChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ worktreeId: 'second' })
    )
    handler.dispose()
  })

  it('cancels each owner tombstone when an atomic replacement arrives', () => {
    const handler = buildEditorExternalWatchEventHandler(() => targets)
    for (const kind of ['delete', 'create'] as const) {
      handler.handleFsChanged({
        worktreePath: '/shared',
        events: [{ kind, absolutePath: '/shared/notes.md' }]
      })
    }
    vi.advanceTimersByTime(100)
    expect(state.setExternalMutation).not.toHaveBeenCalled()
    expect(notifyEditorExternalFileChange).toHaveBeenCalledTimes(2)
    handler.dispose()
  })
})
