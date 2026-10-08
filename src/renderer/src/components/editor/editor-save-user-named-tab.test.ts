import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import type { AppState } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))

function createEditorStore(): StoreApi<AppState> {
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-explicit-any -- SAFETY: the editor save path reads only the slice and fields built here.
  return createStore<any>()((...args: any[]) => ({
    settings: { editorAutoSave: false },
    repos: [],
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

async function saveDirtyFiles(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
        detail: {
          claim: () => {},
          resolve,
          reject: (message: string) => reject(new Error(message))
        }
      })
    )
  })
}

describe('saving a restored tab', () => {
  let writeFile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: { fs: { writeFile } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it.each([
    ['a floating-workspace tab', 'notes.txt', FLOATING_TERMINAL_WORKTREE_ID, '/Users/me/notes.txt'],
    ['a tab stored by absolute path', '/tmp/audit.md', 'wt-1', '/tmp/audit.md']
  ])('saves %s as the file the user named', async (_label, relativePath, worktreeId, filePath) => {
    const store = createEditorStore()
    // Hydration restores the tab exactly as persisted; nothing is re-granted first.
    store
      .getState()
      .openFile({ filePath, relativePath, worktreeId, language: 'markdown', mode: 'edit' })
    store.getState().setEditorDraft(filePath, 'edited')
    store.getState().markFileDirty(filePath, true)
    const detach = attachEditorAutosaveController(store)
    try {
      await saveDirtyFiles()

      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath, content: 'edited', access: { kind: 'user-file' } })
      )
    } finally {
      detach()
    }
  })

  it('saves a project tab inside its root, with no declared access', async () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/a.ts', 'edited')
    store.getState().markFileDirty('/repo/a.ts', true)
    const detach = attachEditorAutosaveController(store)
    try {
      await saveDirtyFiles()

      expect(writeFile).toHaveBeenCalledTimes(1)
      expect(writeFile.mock.calls[0]?.[0]).not.toHaveProperty('access')
    } finally {
      detach()
    }
  })
})
