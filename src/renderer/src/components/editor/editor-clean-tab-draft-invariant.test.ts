// Clean tabs must not retain disk-text drafts that could later overwrite a shared model.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { requestEditorFileSave } from './editor-autosave'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'

import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))

function openCleanTab(disk: string, language = 'typescript') {
  const store = createEditorStore()
  storeRef.current = store
  store.getState().openFile({
    filePath: GUARDED_PATH,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language,
    mode: 'edit'
  })
  const id = store.getState().openFiles[0].id
  store.getState().setLastKnownDiskSignature(id, getDiskBaselineSignature(disk))
  return { store, id }
}

function expectNoCleanDraft(store: ReturnType<typeof createEditorStore>): void {
  for (const tab of store.getState().openFiles) {
    if (!tab.isDirty) {
      expect(store.getState().editorDrafts[tab.id]).toBeUndefined()
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  stubGuardedDisk({ [GUARDED_PATH]: 'disk' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
})

it('save completion leaves no draft on the now-clean tab', async () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'saved text')
  store.getState().markFileDirty(id, true)
  const cleanup = attachEditorAutosaveController(store)
  try {
    await requestEditorFileSave({ fileId: id })
    expectNoCleanDraft(store)
  } finally {
    cleanup()
  }
})

it('reload leaves no draft', () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'mine')
  store.getState().markFileDirty(id, true)
  reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
  expectNoCleanDraft(store)
})

it("a reload keeps a clean Markdown tab's trailing-whitespace draft, but not one over older text", () => {
  const { store, id } = openCleanTab('# notes', 'markdown')
  store.getState().setEditorDraft(id, '# notes\n\n')
  stampCleanTabDiskBaseline(id, { content: '# notes', isBinary: false })
  expect(store.getState().editorDrafts[id]).toBe('# notes\n\n')

  stampCleanTabDiskBaseline(id, { content: '# newer notes', isBinary: false })
  expect(store.getState().editorDrafts[id]).toBeUndefined()
})

it('a reload drops a whitespace-only Markdown draft when disk moved, even by whitespace alone', () => {
  const { store, id } = openCleanTab('# notes', 'markdown')
  store.getState().setEditorDraft(id, '# notes\n\n')
  // An outside write added a trailing newline; keeping the draft would undo it.
  stampCleanTabDiskBaseline(id, { content: '# notes\n', isBinary: false })
  expect(store.getState().editorDrafts[id]).toBeUndefined()
})
