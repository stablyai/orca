import { createTabsSlice } from '@/store/slices/tabs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import {
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorFileSave,
  requestEditorSaveQuiesce
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
afterEach(() => {
  __clearSelfWriteRegistryForTests()
  vi.unstubAllGlobals()
})
function setup() {
  const write = stubEditorWindow()
  const blocked = Promise.withResolvers<void>()
  write.mockReturnValueOnce(blocked.promise)
  const store = createEditorStore()
  store.setState(createTabsSlice(store.setState, store.getState, store))
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Missing fixture settings')
  }
  store.setState({
    settings: { ...settings, editorAutoSave: false },
    folderWorkspaces: [],
    projectGroups: [],
    browserTabsByWorktree: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  const open = () =>
    store.getState().openFile({
      filePath: '/repo/file.txt',
      relativePath: 'file.txt',
      worktreeId: 'wt-1',
      mode: 'edit',
      language: 'text'
    })
  const id = open()
  store.getState().setEditorDraft(id, 'dispatched contents')
  store.getState().markFileDirty(id, true)
  const detach = attachEditorAutosaveController(store)
  const results: string[] = []
  const request = () =>
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, {
        detail: { fileId: id, resolve: (value: string) => results.push(value) }
      })
    )
  return { store, id, open, write, blocked, detach, request, results }
}
it('retains the dirty draft after its controller is disposed during a dispatched write', async () => {
  const f = setup()
  f.request()
  await nextTurn()
  f.detach()
  f.blocked.resolve()
  await nextTurn()
  expect(f.store.getState().editorDrafts[f.id]).toBe('dispatched contents')
  expect(f.store.getState().openFiles.find((file) => file.id === f.id)?.isDirty).toBe(true)
  expect(f.results).toEqual(['retained'])
})
it('retains a newer reopened draft when an old save-close write completes', async () => {
  const f = setup()
  try {
    f.request()
    await nextTurn()
    f.store.getState().closeFile(f.id)
    expect(f.open()).toBe(f.id)
    f.store.getState().setEditorDraft(f.id, 'reopened newer draft')
    f.store.getState().markFileDirty(f.id, true)
    f.blocked.resolve()
    await nextTurn()
    expect(f.store.getState().editorDrafts[f.id]).toBe('reopened newer draft')
    expect(f.results).toEqual(['retained'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it('retains a clean reopened tab when an old save-close write completes', async () => {
  const f = setup()
  try {
    f.request()
    await nextTurn()
    f.store.getState().closeFile(f.id)
    expect(f.open()).toBe(f.id)
    f.blocked.resolve()
    await nextTurn()
    expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(true)
    expect(f.results).toEqual(['retained'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it('retains the current dirty draft when quiescence invalidates the dispatched write', async () => {
  const f = setup()
  try {
    f.request()
    await nextTurn()
    const drained = requestEditorSaveQuiesce({ fileId: f.id })
    f.blocked.resolve()
    await drained
    await nextTurn()
    expect(f.store.getState().editorDrafts[f.id]).toBe('dispatched contents')
    expect(f.results).toEqual(['retained'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it('does not let the detached controller close a tab saved by its successor', async () => {
  const f = setup()
  let nextDetach = () => {}
  try {
    f.request()
    await nextTurn()
    f.detach()
    nextDetach = attachEditorAutosaveController(f.store)
    await requestEditorFileSave({ fileId: f.id })
    f.blocked.resolve()
    await nextTurn()
    expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(true)
    expect(f.results).toEqual(['retained'])
  } finally {
    f.blocked.resolve()
    f.detach()
    nextDetach()
  }
})
it('retains a recently closed tab even when its saved provenance is reused on reopen', async () => {
  const f = setup()
  const before = f.store.getState().openFiles.find((file) => file.id === f.id)?.operationProvenance
  const tabId = f.store.getState().unifiedTabsByWorktree['wt-1'][0]?.id
  try {
    f.request()
    await nextTurn()
    f.store.getState().closeFile(f.id)
    expect(f.store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(f.store.getState().openFiles.find((file) => file.id === f.id)?.operationProvenance).toBe(
      before
    )
    expect(f.store.getState().unifiedTabsByWorktree['wt-1'][0]?.id).not.toBe(tabId)
    f.blocked.resolve()
    await nextTurn()
    expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(true)
    expect(f.results).toEqual(['retained'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it('closes a saved restored tab with no persisted operation provenance on its first request', async () => {
  const f = setup()
  try {
    f.store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        'wt-1': [
          {
            filePath: f.id,
            relativePath: 'file.txt',
            worktreeId: 'wt-1',
            language: 'text',
            dirtyDraftContent: 'restored draft'
          }
        ]
      }
    })
    expect(
      f.store.getState().openFiles.find((file) => file.id === f.id)?.operationProvenance
    ).toBeUndefined()
    f.request()
    await nextTurn()
    f.blocked.resolve()
    await nextTurn()
    expect(f.write.mock.calls[0]?.[0]?.content).toBe('restored draft')
    expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(false)
    expect(f.results).toEqual(['closed'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it('retains a tokenless saved file without authorizing a close or deletion', async () => {
  const f = setup()
  try {
    f.store.setState({ unifiedTabsByWorktree: {} })
    f.request()
    await nextTurn()
    f.blocked.resolve()
    await nextTurn()
    expect(f.write).toHaveBeenCalledOnce()
    expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(true)
    expect(window.api.fs.deletePath).not.toHaveBeenCalled()
    expect(f.results).toEqual(['retained'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it.each(['unpublished owner', 'restoring owner'] as const)(
  'keeps the draft when the queue refuses %s',
  async (reason) => {
    const f = setup()
    try {
      if (reason === 'unpublished owner') {
        f.store.setState({ worktreesByRepo: {} })
      } else {
        f.store.getState().setRestoredEditorOwnerMigrationPending(f.id, true)
      }
      f.request()
      await nextTurn()
      expect(f.write).not.toHaveBeenCalled()
      expect(f.store.getState().editorDrafts[f.id]).toBe('dispatched contents')
      expect(f.store.getState().openFiles.find((file) => file.id === f.id)?.isDirty).toBe(true)
      expect(f.results).toEqual(['failed'])
    } finally {
      f.blocked.resolve()
      f.detach()
    }
  }
)
it('preserves close authority through ordinary save and editor metadata updates', async () => {
  const f = setup()
  const provenance = f.store
    .getState()
    .openFiles.find((file) => file.id === f.id)?.operationProvenance
  try {
    f.request()
    await nextTurn()
    f.store.getState().setLastKnownDiskSignature(f.id, 'prior signature')
    f.store.getState().setPendingDiskBaselineVerification(f.id, true)
    f.store.getState().clearPendingDiskBaselineVerification(f.id)
    f.store.getState().setPendingLiveDiskVerification(f.id, false)
    f.store.getState().setExternalMutation(f.id, 'changed')
    f.store.getState().openFile({
      filePath: f.id,
      relativePath: 'file.txt',
      worktreeId: 'wt-1',
      mode: 'edit',
      language: 'plaintext'
    })
    expect(f.store.getState().openFiles.find((file) => file.id === f.id)?.operationProvenance).toBe(
      provenance
    )
    f.blocked.resolve()
    await nextTurn()
    expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(false)
    expect(f.results).toEqual(['closed'])
  } finally {
    f.blocked.resolve()
    f.detach()
  }
})
it.each(['replacement-ssh-target', '  '] as const)(
  'checks normalized external SSH target %j independently of the tab UUID',
  async (target) => {
    const f = setup()
    try {
      f.request()
      await nextTurn()
      f.store.setState((state) => ({
        openFiles: state.openFiles.map((file) =>
          file.id === f.id ? { ...file, externalSshTargetId: target } : file
        )
      }))
      f.blocked.resolve()
      await nextTurn()
      expect(f.store.getState().openFiles.some((file) => file.id === f.id)).toBe(
        target.trim().length > 0
      )
      expect(f.results).toEqual([target.trim() ? 'retained' : 'closed'])
    } finally {
      f.blocked.resolve()
      f.detach()
    }
  }
)
