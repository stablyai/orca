import { vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { ORCA_EDITOR_FILE_SAVED_EVENT, type EditorFileSavedDetail } from './editor-autosave'
import { withRecordDiskText } from './editor-buffer-adapter'
import { isEditorContentUnchanged } from './editor-content-dirty-state'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'

export const CLOSED_VIEW_PATH = '/repo/a.md'

export function closedViewWorktree(
  id: string,
  hostId: ExecutionHostId = 'local'
): ReturnType<typeof makeWorktree> {
  return makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId })
}

export function closedViewTab(id: string, worktreeId: string): OpenFile {
  return {
    id,
    filePath: CLOSED_VIEW_PATH,
    relativePath: 'a.md',
    worktreeId,
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: getDiskBaselineSignature('disk')
  }
}

export type ClosedViewHarness = {
  disk: FakeEditorDisk
  store: ReturnType<typeof createEditorStore>
  queue: EditorSaveQueue
  /** Loaded disk text per view, advanced by saved events for dirty comparisons. */
  loaded: Record<string, { content: string; isBinary: boolean }>
  view: (id: string) => OpenFile
  recordOf: (id: string) => string
  /** Match panel edits: publish draft, then compare dirty state against loaded text. */
  type: (id: string, text: string) => void
  /** The next write waits for `release`; `refuse` makes it a changed-on-disk refusal. */
  holdNextWrite: (refuse?: boolean) => void
  release: () => void
  closeView: (id: string) => void
  dispose: () => void
}

/** Share one record across two workspace views; only explicit saves write because autosave is not scheduled. */
export function createClosedViewHarness(): ClosedViewHarness {
  vi.useFakeTimers()
  const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [CLOSED_VIEW_PATH]: 'disk' }))
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: { 'repo-1': [closedViewWorktree('wt-1'), closedViewWorktree('wt-2')] },
    openFiles: [closedViewTab('A', 'wt-1'), closedViewTab('B', 'wt-2')]
  })
  let releaseWrite = (): void => {}
  const h: ClosedViewHarness = {
    disk,
    store,
    queue: createEditorSaveQueue(store),
    loaded: { A: { content: 'disk', isBinary: false }, B: { content: 'disk', isBinary: false } },
    view: (id) => {
      const found = store.getState().openFiles.find((openFile) => openFile.id === id)
      if (!found) {
        throw new Error(`no view ${id}`)
      }
      return found
    },
    recordOf: (id) => store.getState().editorBufferIdOf[id],
    type: (id, text) => {
      store.getState().setEditorDraft(id, text)
      store
        .getState()
        .markFileDirty(id, !isEditorContentUnchanged(text, h.loaded[id]?.content ?? '', true))
    },
    holdNextWrite: (refuse = false) => {
      const gate = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      disk.fs.writeFile.mockImplementationOnce(
        async ({ filePath, content }: { filePath: string; content: string }) => {
          await gate
          if (refuse) {
            return { ok: false, diskConflict: 'changed' }
          }
          disk.files.set(filePath, content)
          return { ok: true }
        }
      )
    },
    release: () => releaseWrite(),
    closeView: (id) => {
      store.setState((s) => ({ openFiles: s.openFiles.filter((file) => file.id !== id) }))
    },
    dispose: () => {
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
      h.queue.dispose()
      __clearSelfWriteRegistryForTests()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  }
  const onSaved = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return
    }
    const detail: EditorFileSavedDetail = event.detail
    h.loaded = withRecordDiskText(
      h.loaded,
      detail.recordViewIds ?? [detail.fileId],
      detail.fileId,
      detail.content
    )
    // As the panel does for an open saving view.
    if (store.getState().openFiles.some((file) => file.id === detail.fileId)) {
      h.loaded = { ...h.loaded, [detail.fileId]: { content: detail.content, isBinary: false } }
    }
  }
  window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
  return h
}
