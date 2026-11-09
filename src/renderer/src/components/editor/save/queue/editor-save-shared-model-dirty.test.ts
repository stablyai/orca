// Dirty records must retain every view’s edits and conflict state without per-view reloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_FILE_CACHE_STALE_EVENT } from '../../autosave/editor-autosave'
import { attachEditorAutosaveController } from '../../autosave/editor-autosave-controller'

import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import { createEditorStore } from '../../autosave/editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { overwriteDiskWithTabEdits } from '../../external-changes/ExternalFileChangeBanner'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' }),
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/files/reads/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

function openSharedTabsWithDirtySibling() {
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  for (const worktreeId of ['wt-1', 'wt-2']) {
    store.getState().openFile({
      filePath: GUARDED_PATH,
      relativePath: 'file.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  for (const tab of [a, b]) {
    store.getState().setLastKnownDiskSignature(tab.id, getDiskBaselineSignature('S0'))
  }
  store.getState().setEditorDraft(b.id, 'unsaved in B')
  store.getState().markFileDirty(b.id, true)
  const tab = (id: string) => store.getState().openFiles.find((file) => file.id === id)
  return { store, a, b, tab }
}

describe('a dirty record shown in several workspaces', () => {
  const dropped: string[] = []
  const onStale = (event: Event): void => {
    if (event instanceof CustomEvent) {
      dropped.push(event.detail.fileId)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    dropped.length = 0
    mocks.readRuntimeFileContent.mockReset()
    stubGuardedDisk({ [GUARDED_PATH]: 'E' })
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
  })

  afterEach(() => {
    window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it("Overwrite from either view writes the record's one draft", async () => {
    const { store, a } = openSharedTabsWithDirtySibling()
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'E' })
    store.getState().setExternalMutation(a.id, 'changed')
    const cleanup = attachEditorAutosaveController(store)
    try {
      expect(store.getState().editorDrafts[a.id]).toBe('unsaved in B')
      expect(await overwriteDiskWithTabEdits(store.getState().openFiles[0])).toBe(true)
      expect(disk.files.get(GUARDED_PATH)).toBe('unsaved in B')
      expect(store.getState().openFiles.every((tab) => !tab.isDirty)).toBe(true)
    } finally {
      cleanup()
    }
  })
})
