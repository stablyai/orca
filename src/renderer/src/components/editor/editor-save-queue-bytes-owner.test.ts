import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { writeRuntimeFileBytes } from '@/runtime/runtime-file-bytes-write'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import {
  editorBytesDocument,
  loadEditorBytes,
  setEditorBytesDraft,
  sha256Hex
} from './editor-bytes-documents'
import { stubEditorWindowWithDisk } from './editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

const { writeBytes, replace } = vi.hoisted(() => ({
  writeBytes: vi.fn<typeof writeRuntimeFileBytes>(),
  replace: vi.fn(async () => ({ ok: true as const }))
}))
vi.mock('@/runtime/runtime-file-bytes-write', () => ({ writeRuntimeFileBytes: writeBytes }))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const loadInitialEditorBytes: (
  fileId: string,
  saved: Parameters<typeof loadEditorBytes>[1],
  savedSha256: string,
  editsAtRead: undefined
) => void = loadEditorBytes

const WORKTREE_ID = 'repo-1::/repo'
const draft = { bytes: new Uint8Array([2, 3]), fileType: 'xlsx' }

describe('binary editor save acquired owner at the final replace boundary', () => {
  let queue: EditorSaveQueue
  let fileId: string
  let started: ReturnType<typeof deferred>
  let uploaded: ReturnType<typeof deferred>

  beforeEach(async () => {
    stubEditorWindowWithDisk()
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ]
      },
      runtimeEnvironmentCatalogHydrated: true
    })
    fileId = useAppStore.getState().openFile(
      {
        filePath: '/repo/book.xlsx',
        relativePath: 'book.xlsx',
        worktreeId: WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'plaintext',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const bytes = new Uint8Array([1])
    loadInitialEditorBytes(fileId, { bytes, fileType: 'xlsx' }, await sha256Hex(bytes), undefined)
    setEditorBytesDraft(fileId, draft)
    queue = createEditorSaveQueue(useAppStore)
    started = deferred()
    uploaded = deferred()
    replace.mockClear()
    writeBytes.mockImplementation(
      async (_context, _path, _bytes, _access, _condition, beforeSend) => {
        started.resolve()
        await uploaded.promise
        beforeSend?.()
        return replace()
      }
    )
  })

  afterEach(() => {
    queue.dispose()
    useAppStore.setState({ openFiles: [] })
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
  })

  const save = (): Promise<string> => {
    const file = useAppStore.getState().openFiles.find((tab) => tab.id === fileId)
    if (!file) {
      throw new Error('Missing editor file')
    }
    return queue.queueSave(file, '')
  }

  it('keeps the captured destination and saves when authority and writer survive the upload', async () => {
    const saved = save()
    await started.promise
    expect(replace).not.toHaveBeenCalled()
    uploaded.resolve()
    await expect(saved).resolves.toBe('written')
    expect(replace).toHaveBeenCalledTimes(1)
    expect(writeBytes.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'local' },
      worktreeId: WORKTREE_ID,
      worktreePath: '/repo'
    })
    expect(useAppStore.getState().openFiles.find((tab) => tab.id === fileId)?.isDirty).toBe(false)
    expect(editorBytesDocument(fileId)?.bytes).toEqual(draft.bytes)
  })

  it('refuses the final replace if the acquired workspace changes during upload, retaining edits', async () => {
    const saved = save()
    await started.promise
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/moved', hostId: 'local' })
        ]
      }
    })
    const refused = expect(saved).rejects.toThrow()
    uploaded.resolve()
    await refused
    expect(replace).not.toHaveBeenCalled()
    expect(useAppStore.getState().openFiles.find((tab) => tab.id === fileId)?.isDirty).toBe(true)
    expect(editorBytesDocument(fileId)).toBe(draft)
  })

  it('refuses the final replace if the last entitled writer closes during upload', async () => {
    const saved = save()
    await started.promise
    useAppStore.setState({ openFiles: [] })
    const refused = expect(saved).rejects.toThrow('This file is no longer open for saving.')
    uploaded.resolve()
    await refused
    expect(replace).not.toHaveBeenCalled()
    expect(useAppStore.getState().openFiles).toEqual([])
    expect(editorBytesDocument(fileId)).toBeNull()
  })
})
