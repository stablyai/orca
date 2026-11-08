import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'

import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import { createEditorSaveQueue } from './editor-save-queue'
import type { EditorSaveQueue } from './editor-save-queue-contract'

import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'

import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from '../../autosave/editor-autosave-controller-test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const PATH = '/repo/a.ts'
const WORKTREES = {
  'repo-1': [
    makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
    makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
  ]
}

// A view opened before a reconnect: its captured connection generation no longer matches.

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: PATH,
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: getDiskBaselineSignature('disk'),
    ...patch
  }
}

describe('editor save queue: shared records', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue

  const type = (viewId: string, text: string): void => {
    store.getState().setEditorDraft(viewId, text)
    store.getState().markFileDirty(viewId, true)
    queue.syncAutoSave()
  }
  const view = (id: string): OpenFile => {
    const found = store.getState().openFiles.find((openFile) => openFile.id === id)
    if (!found) {
      throw new Error(`no view ${id}`)
    }
    return found
  }

  beforeEach(() => {
    vi.useFakeTimers()
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: 'disk' }))
    store = createEditorStore()
    store.setState({ worktreesByRepo: WORKTREES })
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    __clearSelfWriteRegistryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('re-keys carry the record', () => {
    it('a stale baseline carried by a rename is refused and bannered on every view', async () => {
      disk.files.set('/repo/old.ts', 'disk')
      disk.files.set(PATH, 'someone else')
      store.setState({
        openFiles: [
          tab('old', { filePath: '/repo/old.ts', relativePath: 'old.ts' }),
          tab('w2', { lastKnownDiskSignature: getDiskBaselineSignature('someone else') })
        ]
      })
      type('old', 'edits')
      store.getState().rekeyOpenFilesForPathChange({
        rekeys: [
          {
            oldFileId: 'old',
            newFileId: 'renamed',
            oldFilePath: '/repo/old.ts',
            newFilePath: PATH,
            newRelativePath: 'a.ts'
          }
        ]
      })

      expect(await queue.queueSave(view('renamed'), 'edits', 'autosave')).toBe('blocked-stale')
      expect(disk.files.get(PATH)).toBe('someone else')
      expect(view('renamed').externalMutation).toBe('changed')
      expect(view('w2').externalMutation).toBe('changed')
      expect(view('w2').isDirty).toBe(true)
    })
  })
})
