// Why: the changed-on-disk conflict flow (issue #7265) — draft preservation,
// echo-aware backstop marking, autosave suspension, and baseline settling —
// in the headless autosave controller. Split from
// editor-autosave-controller.test.ts to stay under max-lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests, recordSelfWrite } from './editor-self-write-registry'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

function openDirtyFile(store: ReturnType<typeof createEditorStore>, draft = 'unsaved edit'): void {
  store.getState().openFile({
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft('/repo/file.ts', draft)
  store.getState().markFileDirty('/repo/file.ts', true)
}

function dispatchExternalChange(): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
      detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
    })
  )
}

describe('editor autosave changed-on-disk conflict flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('preserves dirty drafts and marks the tab changed-on-disk on external file change', () => {
    stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store)

    const cleanup = attachEditorAutosaveController(store)
    try {
      dispatchExternalChange()

      const file = store.getState().openFiles[0]
      expect(file?.isDirty).toBe(true)
      expect(file?.externalMutation).toBe('changed')
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('unsaved edit')
    } finally {
      cleanup()
    }
  })

  it('clears drafts and a stale changed-on-disk mark for clean tabs on external file change', () => {
    stubEditorWindow()
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setExternalMutation('/repo/file.ts', 'changed')

    const cleanup = attachEditorAutosaveController(store)
    try {
      dispatchExternalChange()

      const file = store.getState().openFiles[0]
      expect(file?.isDirty).toBe(false)
      expect(file?.externalMutation).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('does not backstop-mark a dirty tab for the echo of its own save', () => {
    stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'typed during save')
    // Why: the combined-Changes reload notification routes through the
    // controller for the saved path — a fresh self-write stamp means the
    // event is Orca's own echo, not an external change.
    recordSelfWrite('/repo/file.ts', 'orca save')

    const cleanup = attachEditorAutosaveController(store)
    try {
      dispatchExternalChange()

      const file = store.getState().openFiles[0]
      expect(file?.externalMutation).toBeUndefined()
      expect(file?.isDirty).toBe(true)
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('typed during save')
    } finally {
      cleanup()
    }
  })

  it('suspends autosave while a tab is marked changed-on-disk and resumes when cleared', async () => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'user edit')
    store.getState().setExternalMutation('/repo/file.ts', 'changed')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(writeFile).not.toHaveBeenCalled()

      // Keep My Edits clears the mark — autosave resumes and overwrites.
      store.getState().setExternalMutation('/repo/file.ts', null)
      await vi.advanceTimersByTimeAsync(1500)
      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.ts',
        content: 'user edit',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
    } finally {
      cleanup()
    }
  })

  it('suspends autosave while a restored tab awaits disk baseline verification', async () => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'restored draft')
    // Why: mimic hydration — the scan has not yet compared disk against the
    // persisted baseline, so autosave must hold off (a slow remote read must
    // not lose a race to this timer).
    store.setState({
      openFiles: store
        .getState()
        .openFiles.map((f) =>
          f.id === '/repo/file.ts' ? { ...f, pendingDiskBaselineVerification: true } : f
        )
    } as never)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(writeFile).not.toHaveBeenCalled()

      store.getState().clearPendingDiskBaselineVerification('/repo/file.ts')
      await vi.advanceTimersByTimeAsync(1500)
      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.ts',
        content: 'restored draft',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
    } finally {
      cleanup()
    }
  })

  it('clears the changed-on-disk mark after a successful save', async () => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'user version')
    store.getState().setExternalMutation('/repo/file.ts', 'changed')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: '/repo/file.ts' })

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.ts',
        content: 'user version',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
      const file = store.getState().openFiles[0]
      expect(file?.isDirty).toBe(false)
      expect(file?.externalMutation).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})
