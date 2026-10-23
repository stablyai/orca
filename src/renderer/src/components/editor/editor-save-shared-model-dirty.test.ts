// Why: views of one file share one record. A view of a dirty record must never be reloaded on its
// own, left without a banner, or sent into a reload loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT,
  requestEditorFileSave
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { attachRestoredTabConflictScan } from './editor-restored-tab-conflict-scan'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  keepTabEditsOverExternalChange,
  overwriteDiskWithTabEdits
} from './ExternalFileChangeBanner'
import { isStaleCachedEditorText } from './editor-stale-mount-guard'
import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' }),
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
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

  it('gets the banner on an external change, not a lone reload, and no reads loop', async () => {
    const { store, a, b, tab } = openSharedTabsWithDirtySibling()
    const cleanup = attachEditorAutosaveController(store)
    try {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
          detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
        })
      )
      await vi.advanceTimersByTimeAsync(5_000)

      expect(tab(a.id)?.externalMutation).toBe('changed')
      expect(tab(b.id)?.externalMutation).toBe('changed')
      // The baseline stays on the version the unsaved text came from; nothing reloads or evicts.
      expect(tab(a.id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('S0'))
      expect(store.getState().editorDrafts[b.id]).toBe('unsaved in B')
      expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
      expect(dropped).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('after a restart, a file changed while closed banners every tab of the model', async () => {
    const { store, a, b, tab } = openSharedTabsWithDirtySibling()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'E', isBinary: false })

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(5_000)

      expect(tab(b.id)?.externalMutation).toBe('changed')
      expect(tab(a.id)?.externalMutation).toBe('changed')
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
      expect(dropped).toEqual([])
    } finally {
      detach()
    }
  })

  it('after Keep, every view shows the kept edits: no eviction, no disk text', async () => {
    const { store, a, b } = openSharedTabsWithDirtySibling()
    store.getState().setExternalMutation(b.id, 'changed')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'E', isBinary: false })

    keepTabEditsOverExternalChange(store.getState().openFiles[1])
    await vi.advanceTimersByTimeAsync(0)

    expect(dropped).toEqual([])
    // A's text is the record's kept draft, never its cached disk text.
    expect(store.getState().editorDrafts[a.id]).toBe('unsaved in B')
    expect(store.getState().editorDrafts[b.id]).toBe('unsaved in B')
  })

  it("drops a clean tab's leftover draft when the model moves to a newer load, so it cannot overwrite", async () => {
    const { store, a, b, tab } = openSharedTabsWithDirtySibling()
    // B undid back to clean but kept a draft equal to the old text; the tab is hidden.
    store.getState().markFileDirty(b.id, false)
    store.getState().setEditorDraft(b.id, 'S0')
    // An agent wrote E; the other workspace's tab loads it while the model is clean.
    stampCleanTabDiskBaseline(a.id, { content: 'E', isBinary: false })

    expect(store.getState().editorDrafts[b.id]).toBeUndefined()
    expect(tab(b.id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('E'))
    expect(dropped).toEqual([b.id])
    // Old text for B can no longer enter the model on remount.
    expect(isStaleCachedEditorText(b.id, 'S0')).toBe(true)
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

  it('Overwrite reports nothing written when no tab of the model holds edits', async () => {
    const { store, b } = openSharedTabsWithDirtySibling()
    store.getState().clearEditorDraft(b.id)
    store.getState().markFileDirty(b.id, false)
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'E' })
    expect(await overwriteDiskWithTabEdits(store.getState().openFiles[0])).toBe(false)
    expect(disk.writeFile).not.toHaveBeenCalled()
  })

  const openThirdView = (store: ReturnType<typeof createEditorStore>) => {
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          ...(store.getState().worktreesByRepo['repo-1'] ?? []),
          makeWorktree({ id: 'wt-3', repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ]
      }
    })
    store.getState().openFile({
      filePath: GUARDED_PATH,
      relativePath: 'file.ts',
      worktreeId: 'wt-3',
      language: 'typescript',
      mode: 'edit'
    })
    return store.getState().openFiles.find((tab) => tab.worktreeId === 'wt-3')!
  }

  it('a view opened later joins the dirty record: its draft, dirty flag and baseline', async () => {
    const { store, b } = openSharedTabsWithDirtySibling()
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'S0' })
    const joined = openThirdView(store)
    expect(joined.isDirty).toBe(true)
    expect(joined.lastKnownDiskSignature).toBe(getDiskBaselineSignature('S0'))
    expect(store.getState().editorDrafts[joined.id]).toBe('unsaved in B')
    // Its panel loading disk text that still matches the baseline changes nothing.
    stampCleanTabDiskBaseline(joined.id, { content: 'S0', isBinary: false })
    expect(store.getState().openFiles.every((tab) => tab.externalMutation === undefined)).toBe(true)

    store.getState().setEditorDraft(joined.id, 'from the new tab')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: joined.id })
      expect(disk.files.get(GUARDED_PATH)).toBe('from the new tab')
      expect(store.getState().editorDrafts[b.id]).toBeUndefined()
      expect(store.getState().openFiles.every((tab) => !tab.isDirty)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('a view joining a dirty record whose disk moved marks the record changed', () => {
    const { store, a, b, tab } = openSharedTabsWithDirtySibling()
    const joined = openThirdView(store)
    stampCleanTabDiskBaseline(joined.id, { content: 'E', isBinary: false })
    for (const id of [a.id, b.id, joined.id]) {
      expect(tab(id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('S0'))
      expect(tab(id)?.externalMutation).toBe('changed')
    }
  })
})
