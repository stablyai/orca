// Use a real editor slice and isolated window/filesystem bridge across autosave suites.
import { vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import { withEditorBufferRecords } from '@/store/editor-buffer-record-lifecycle'
import type { AppState } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { emptyTabLayoutState } from '@/store/slices/editor-slice-test-harness'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import {
  compareDiskWritePrecondition,
  type FileWriteDiskPrecondition
} from '../../../../shared/file-write-disk-precondition'

export type FakeEditorDisk = {
  files: Map<string, string>
  fs: {
    writeFile: ReturnType<typeof vi.fn>
    deletePath: ReturnType<typeof vi.fn>
    stat: ReturnType<typeof vi.fn>
  }
}

/** Back the filesystem stub with in-memory disk contents so assertions observe landed writes. */
export function createFakeEditorDisk(initialFiles: Record<string, string> = {}): FakeEditorDisk {
  const files = new Map(Object.entries(initialFiles))
  return {
    files,
    fs: {
      writeFile: vi.fn(
        async ({
          filePath,
          content,
          diskPrecondition
        }: {
          filePath: string
          content: string
          diskPrecondition?: FileWriteDiskPrecondition
        }) => {
          const diskConflict = diskPrecondition
            ? compareDiskWritePrecondition(diskPrecondition, files.get(filePath) ?? null, content)
            : null
          if (diskConflict === 'identical') {
            return { ok: true, unchanged: true }
          }
          if (diskConflict) {
            return { ok: false, diskConflict }
          }
          files.set(filePath, content)
          return { ok: true }
        }
      ),
      deletePath: vi.fn(async ({ targetPath }: { targetPath: string }) => {
        files.delete(targetPath)
      }),
      stat: vi.fn(async ({ filePath }: { filePath: string }) => {
        const content = files.get(filePath)
        if (content === undefined) {
          throw new Error(`ENOENT: no such file ${filePath}`)
        }
        return { size: content.length, isDirectory: false, mtime: 0 }
      })
    }
  }
}

export type EditorWindowStub = {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  api: { fs: FakeEditorDisk['fs'] }
}

/** Stubs the global window with an isolated event target backed by `disk`. */
export function stubEditorWindowWithDisk(
  disk: FakeEditorDisk = createFakeEditorDisk()
): FakeEditorDisk {
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: { fs: disk.fs }
  } satisfies EditorWindowStub)
  return disk
}

/** Return the isolated window filesystem’s write mock. */
export function stubEditorWindow(): ReturnType<typeof vi.fn> {
  return stubEditorWindowWithDisk().fs.writeFile
}

export function createEditorStore(): StoreApi<AppState> {
  // Use the app’s record middleware so views of one file share a buffer.
  // oxlint-disable-next-line typescript/no-explicit-any -- a partial store; tests read only the slices it builds.
  const create = withEditorBufferRecords<any>(
    (...args: any[]) => ({
      ...emptyTabLayoutState(),
      activeWorktreeId: 'wt-1',
      repos: [],
      folderWorkspaces: [],
      projectGroups: [],
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
    }),
    true
  )
  // oxlint-disable-next-line typescript/no-explicit-any, typescript/consistent-type-assertions -- SAFETY: as above.
  return createStore<any>()(create) as unknown as StoreApi<AppState>
}

/** Store with a local worktree at /repo and an open, untouched untitled note at /repo/`fileName`. */
export function createUntitledNoteStore(fileName: string): StoreApi<AppState> {
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    },
    browserTabsByWorktree: {},
    tabsByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  store.getState().openFile({
    filePath: `/repo/${fileName}`,
    relativePath: fileName,
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit',
    isUntitled: true
  })
  return store
}

/** Stamp loaded-file baselines in fixtures; saves without known disk versions are refused. */
export function withLoadedBaselines<T extends Pick<StoreApi<AppState>, 'getState'>>(
  store: T,
  disk?: FakeEditorDisk
): T {
  const state = store.getState()
  for (const file of state.openFiles) {
    if (file.lastKnownDiskSignature === undefined) {
      const loaded = disk ? disk.files.get(file.filePath) : ''
      if (loaded !== undefined) {
        state.setLastKnownDiskSignature(file.id, getDiskBaselineSignature(loaded))
      }
    }
  }
  return store
}
