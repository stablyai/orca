// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type * as EditorAutosave from './editor-autosave'
import type { EditorRequestFileReloadDetail } from './editor-autosave'

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  getState: vi.fn(),
  quiesce: vi.fn(async (_target: unknown, _resume?: Promise<void>): Promise<void> => {})
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('./editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof EditorAutosave>()),
  requestEditorSaveQuiesce: mocks.quiesce
}))
import { ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT } from './editor-autosave'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { requestEditorTabDiskReload } from './editor-tab-disk-reload'

const file: OpenFile = {
  id: 'file-1',
  filePath: '/repo/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  mode: 'edit',
  isDirty: true
}

let requests: EditorRequestFileReloadDetail[] = []
const listener = (event: Event): void => {
  if (event instanceof CustomEvent) {
    event.detail.claim()
    requests.push(event.detail)
  }
}
function makeState(
  openFiles = [file],
  editorDrafts: Record<string, string> = { 'file-1': 'draft' }
) {
  return {
    openFiles,
    editorDrafts,
    clearEditorDraft: vi.fn(),
    markFileDirty: vi.fn(),
    setExternalMutation: vi.fn()
  }
}
function beforeApply(): boolean {
  const request = requests[0]
  if (!request) {
    throw new Error('No reload requested')
  }
  return request.beforeApply()
}

beforeEach(() => {
  vi.clearAllMocks()
  requests = []
  window.addEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, listener)
})
afterEach(() => window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, listener))

describe('manual disk reload transaction', () => {
  it('retains dirty content until the loader has successfully read disk', async () => {
    const state = makeState()
    mocks.getState.mockReturnValue(state)
    await requestEditorTabDiskReload(file.id)
    expect(mocks.quiesce).toHaveBeenCalledWith({ fileId: file.id }, expect.any(Promise))
    expect(state.clearEditorDraft).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(beforeApply()).toBe(true)
    expect(state.clearEditorDraft).toHaveBeenCalledWith(file.id)
    expect(mocks.toast).toHaveBeenCalledOnce()
    expect(beforeApply()).toBe(true)
    expect(mocks.toast).toHaveBeenCalledOnce()
  })

  it('keeps the draft and conflict after a failed remote read', async () => {
    const state = makeState()
    mocks.getState.mockReturnValue(state)
    await requestEditorTabDiskReload(file.id)
    requests[0]?.onError(new Error('Connection dropped'))
    expect(state.clearEditorDraft).not.toHaveBeenCalled()
    expect(state.markFileDirty).not.toHaveBeenCalled()
    expect(state.setExternalMutation).not.toHaveBeenCalled()
    expect(mocks.toast.error).toHaveBeenCalledWith('Could not reload from disk', {
      description: 'Connection dropped'
    })
  })

  it.each(['new edit', 'closed tab', 'saved file'])(
    'does not overwrite a %s during the read',
    async (change) => {
      const state = makeState()
      mocks.getState.mockReturnValue(state)
      await requestEditorTabDiskReload(file.id)
      if (change === 'new edit') {
        state.editorDrafts[file.id] = 'newer draft'
      }
      if (change === 'closed tab') {
        state.openFiles = []
      }
      if (change === 'saved file') {
        state.openFiles = [{ ...file, lastKnownDiskSignature: 'saved' }]
      }
      expect(beforeApply()).toBe(false)
      expect(state.clearEditorDraft).not.toHaveBeenCalled()
    }
  )

  it('flushes debounced markdown edits before checking for newer content', async () => {
    const state = makeState()
    mocks.getState.mockReturnValue(state)
    await requestEditorTabDiskReload(file.id)
    const unregister = registerPendingEditorFlush(file.id, () => {
      state.editorDrafts[file.id] = 'new markdown draft'
    })
    expect(beforeApply()).toBe(false)
    unregister()
    expect(state.clearEditorDraft).not.toHaveBeenCalled()
  })

  it('waits for a pending save before reading', async () => {
    const state = makeState()
    mocks.getState.mockReturnValue(state)
    let finishSave = (): void => {}
    mocks.quiesce.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSave = resolve
      })
    )
    const pending = requestEditorTabDiskReload(file.id)
    expect(requests).toEqual([])
    finishSave()
    await pending
    expect(requests).toHaveLength(1)
  })

  it('keeps edits made while an earlier save drains', async () => {
    const state = makeState()
    mocks.getState.mockReturnValue(state)
    let finishSave = (): void => {}
    mocks.quiesce.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSave = resolve
      })
    )
    const pending = requestEditorTabDiskReload(file.id)
    state.editorDrafts[file.id] = 'typed during pending save'
    finishSave()
    await pending
    expect(beforeApply()).toBe(false)
    expect(state.clearEditorDraft).not.toHaveBeenCalled()
  })

  it('releases the autosave hold when no editor panel can read the file', async () => {
    mocks.getState.mockReturnValue(makeState())
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, listener)
    await requestEditorTabDiskReload(file.id)
    await expect(mocks.quiesce.mock.calls[0]?.[1]).resolves.toBeUndefined()
  })

  it('ignores missing tabs and combined diffs', async () => {
    mocks.getState.mockReturnValue(
      makeState([{ ...file, mode: 'diff', diffSource: 'combined-uncommitted' }])
    )
    await requestEditorTabDiskReload(file.id)
    await requestEditorTabDiskReload('missing')
    expect(requests).toEqual([])
    expect(mocks.quiesce).not.toHaveBeenCalled()
  })
})
