// Clean tabs must not retain disk-text drafts that could later overwrite a shared model.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from '../autosave/editor-autosave-controller-test-fixture'

import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from '../save/queue/editor-save-guarded-disk-fixture'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))

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

beforeEach(() => {
  vi.useFakeTimers()
  stubGuardedDisk({ [GUARDED_PATH]: 'disk' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
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
