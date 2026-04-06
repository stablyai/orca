import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import type { AppState } from '@/store'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'

type WindowStub = {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  api: {
    fs: {
      writeFile: ReturnType<typeof vi.fn>
    }
  }
}

function createEditorStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    settings: {
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1000
    },
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

async function requestDirtyFileSave(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
        detail: {
          claim: () => {
            claimed = true
          },
          resolve,
          reject: (message: string) => reject(new Error(message))
        }
      })
    )

    if (!claimed) {
      resolve()
    }
  })
}

describe('attachEditorAutosaveController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('saves dirty files even when the visible EditorPanel is not mounted', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/file.ts', 'edited')
    store.getState().markFileDirty('/repo/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.ts',
        content: 'edited'
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
      expect(store.getState().editorDrafts).toEqual({})
    } finally {
      cleanup()
    }
  })

  it('quiesces pending autosave timers without needing the editor UI tree', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    const cleanup = attachEditorAutosaveController(store)
    try {
      store.getState().setEditorDraft('/repo/file.ts', 'edited')
      store.getState().markFileDirty('/repo/file.ts', true)

      await requestEditorSaveQuiesce({ fileId: '/repo/file.ts' })
      await vi.advanceTimersByTimeAsync(1000)

      expect(writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('edited')
    } finally {
      cleanup()
    }
  })
})
