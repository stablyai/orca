/* eslint-disable max-lines -- Why: autosave behavior depends on event wiring,
   dirty drafts, remote routing, quiesce, and failure cleanup in one harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import type { AppState } from '@/store'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { __clearSelfWriteRegistryForTests, hasRecentSelfWrite } from './editor-self-write-registry'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

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
    runtimeEnvironments?: {
      call: ReturnType<typeof vi.fn>
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
    __clearSelfWriteRegistryForTests()
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

  it('saves remote files through the owning runtime environment', async () => {
    clearRuntimeCompatibilityCacheForTests()
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const runtimeCall = vi.fn().mockResolvedValue({
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-env-1' }
    })
    const runtimeTransportCall = vi.fn((args: RuntimeEnvironmentCallRequest) => {
      return (
        createCompatibleRuntimeStatusResponseIfNeeded(args, 'runtime-env-1') ?? runtimeCall(args)
      )
    })
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: { writeFile },
        runtimeEnvironments: { call: runtimeTransportCall }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.setState({
      settings: {
        editorAutoSave: true,
        editorAutoSaveDelayMs: 1000,
        activeRuntimeEnvironmentId: 'env-2'
      } as never,
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' }] as never
      }
    })
    store.getState().openFile({
      filePath: '/remote/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/remote/repo/file.ts', 'edited')
    store.getState().markFileDirty('/remote/repo/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.write',
        params: { worktree: 'wt-1', relativePath: 'file.ts', content: 'edited' },
        timeoutMs: 15_000
      })
      expect(writeFile).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('flushes mounted rich-editor changes before restart-driven dirty-file saves', async () => {
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
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().markFileDirty('/repo/file.md', true)

    const unregisterFlush = registerPendingEditorFlush('/repo/file.md', () => {
      store.getState().setEditorDraft('/repo/file.md', 'pending rich edit')
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.md',
        content: 'pending rich edit'
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
      expect(store.getState().editorDrafts).toEqual({})
    } finally {
      cleanup()
      unregisterFlush()
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

  it('skips the open-file scan for unrelated store mutations', () => {
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

    const openFiles = store.getState().openFiles
    const originalMap = openFiles.map.bind(openFiles)
    let mapCalls = 0
    Object.defineProperty(openFiles, 'map', {
      configurable: true,
      value: (...args: Parameters<typeof openFiles.map>) => {
        mapCalls += 1
        return originalMap(...args)
      }
    })

    const cleanup = attachEditorAutosaveController(store)
    try {
      expect(mapCalls).toBe(1)
      mapCalls = 0

      store.setState({ activeWorktreeId: 'wt-2' } as Partial<AppState>)
      expect(mapCalls).toBe(0)

      store.getState().setEditorDraft('/repo/file.ts', 'edited')
      expect(mapCalls).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('flushes mounted rich-editor changes before quiescing or direct saves', async () => {
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
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().markFileDirty('/repo/file.md', true)

    const drafts = ['after quiesce', 'after save']
    const unregisterFlush = registerPendingEditorFlush('/repo/file.md', () => {
      const nextDraft = drafts.shift()
      if (nextDraft) {
        store.getState().setEditorDraft('/repo/file.md', nextDraft)
      }
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorSaveQuiesce({ fileId: '/repo/file.md' })
      expect(store.getState().editorDrafts['/repo/file.md']).toBe('after quiesce')
      expect(writeFile).not.toHaveBeenCalled()

      await requestEditorFileSave({ fileId: '/repo/file.md' })
      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.md',
        content: 'after save'
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
      unregisterFlush()
    }
  })

  it('clears the self-write stamp when a save fails before touching disk', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'))
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
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/file.md', 'edited')
    store.getState().markFileDirty('/repo/file.md', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: '/repo/file.md' })).rejects.toThrow('disk full')
      expect(hasRecentSelfWrite('/repo/file.md')).toBe(false)
    } finally {
      cleanup()
    }
  })
})
