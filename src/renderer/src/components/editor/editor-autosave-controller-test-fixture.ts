// Why: shared rig for autosave-controller suites — the controller needs a
// real editor store slice plus a window stub (event target, timers, fs
// bridge), and duplicating that per test file bloats suites past max-lines.
import { vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import type { AppState } from '@/store'

export type EditorWindowStub = {
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

/** Stubs the global window with an isolated event target and fs bridge;
 *  returns the writeFile mock for assertions. */
export function stubEditorWindow(): ReturnType<typeof vi.fn> {
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
  } satisfies EditorWindowStub)
  return writeFile
}

export function createEditorStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    repos: [],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: {},
    sshStateByEnvironment: {},
    settings: {
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1000
    },
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}
