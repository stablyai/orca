import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { createEditorTabsStore } from '../editor-slice-test-harness'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const live = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => {
      if (!live.store) {
        throw new Error('No test store')
      }
      return live.store.getState()
    }
  }
}))

let store: StoreApi<AppState>
let file: OpenFile

beforeEach(() => {
  store = createEditorTabsStore()
  live.store = store
  store.getState().openFile({
    filePath: '/repo/note.md',
    relativePath: 'note.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
  const opened = store.getState().openFiles[0]
  if (!opened) {
    throw new Error('Document did not open')
  }
  file = opened
})

afterEach(() => {
  live.store = null
  vi.unstubAllGlobals()
})

describe('closing duplicate document records', () => {
  it.each(['closeFile', 'closeAllFiles'] as const)(
    '%s cancels placeholder deletion when its document reopens during stat',
    async (action) => {
      let finishStat:
        | ((value: { size: number; isDirectory: boolean; mtime: number }) => void)
        | undefined
      const stat = vi.fn(
        () =>
          new Promise<{ size: number; isDirectory: boolean; mtime: number }>((resolve) => {
            finishStat = resolve
          })
      )
      const deletePath = vi.fn(async () => {})
      vi.stubGlobal('window', { api: { fs: { stat, deletePath } } })
      store.setState({ openFiles: [{ ...file, isUntitled: true }] })
      if (action === 'closeFile') {
        store.getState().closeFile(file.id)
      } else {
        store.getState().closeAllFiles()
      }
      store.getState().openFile(file)
      if (!finishStat) {
        throw new Error('Stat did not start')
      }
      finishStat({ size: 0, isDirectory: false, mtime: 0 })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(deletePath).not.toHaveBeenCalled()
      expect(store.getState().openFiles).toHaveLength(1)
    }
  )
})
