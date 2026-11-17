import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'

import { createEditorSlice } from '@/store/slices/editor/create-editor-slice'
import type { AppState } from '@/store/types'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT
} from '../../../../../shared/editor/saving/editor-save-events'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { registerPendingEditorFlush } from '../save/flush/editor-pending-flush'
import { __clearSelfWriteRegistryForTests } from '../external-changes/editor-self-write-registry'
import '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import '../../../../../shared/orca-profiles/constants'
import '@/store/slices/worktrees/worktree.test-fixture'

import { emptyTabLayoutState } from '../../../store/slices/editor/editor-slice-test-harness'
import { withLoadedBaselines } from './editor-autosave-controller-test-fixture'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

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
  // oxlint-disable-next-line typescript/no-explicit-any, typescript/consistent-type-assertions -- SAFETY: a partial store; tests read only the slices it builds.
  return createStore<any>()((...args: any[]) => ({
    ...emptyTabLayoutState(),
    activeWorktreeId: 'wt-1',
    settings: {
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1000
    },
    repos: [],
    folderWorkspaces: [],
    projectGroups: [],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
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

async function requestEditorHotExitBackup(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, {
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

function makeSessionReadyState(): Partial<AppState> {
  return {
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    activeRepoId: 'repo-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: null, worktreeId: 'wt-1' } as never]
    },
    ptyIdsByTabId: { 'tab-1': [] },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {}
  } as Partial<AppState>
}

describe('attachEditorAutosaveController', () => {
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
    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      await requestDirtyFileSave()

      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/repo/file.md',
          content: 'pending rich edit',
          connectionId: undefined,
          expectedExecutionHostId: 'local'
        })
      )
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

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
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

  it('leaves dirty editor drafts ready for the combined hot-exit checkpoint', async () => {
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
    store.setState(makeSessionReadyState())
    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/file.md', '')
    store.getState().markFileDirty('/repo/file.md', true)

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      await requestEditorHotExitBackup()
      await vi.advanceTimersByTimeAsync(1000)

      expect(writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      expect(store.getState().editorDrafts['/repo/file.md']).toBe('')
    } finally {
      cleanup()
    }
  })

  it('rejects hot exit for dirty non-edit files that cannot be restored', async () => {
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
    store.setState(makeSessionReadyState())
    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'diff',
      diffSource: 'unstaged'
    } as never)
    store.getState().setEditorDraft('/repo/file.md', 'diff edit')
    store.getState().markFileDirty('/repo/file.md', true)

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      await expect(requestEditorHotExitBackup()).rejects.toThrow(
        'Some unsaved editor changes cannot be backed up before restart.'
      )
      expect(writeFile).not.toHaveBeenCalled()
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
    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      await requestEditorSaveQuiesce({ fileId: '/repo/file.md' })
      expect(store.getState().editorDrafts['/repo/file.md']).toBe('after quiesce')
      expect(writeFile).not.toHaveBeenCalled()

      await requestEditorFileSave({ fileId: '/repo/file.md' })
      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/repo/file.md',
          content: 'after save',
          connectionId: undefined,
          expectedExecutionHostId: 'local'
        })
      )
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
      unregisterFlush()
    }
  })
})
