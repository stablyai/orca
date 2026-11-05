// Keep text, disk baseline and conflict state synchronized across workspaces sharing one Monaco model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import { createEditorStore } from '../../autosave/editor-autosave-controller-test-fixture'
import { reloadTabContentFromDisk } from '../../external-changes/ExternalFileChangeBanner'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'

import { GUARDED_PATH } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

function openSharedTabs(disk: string) {
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
    store.getState().setLastKnownDiskSignature(tab.id, getDiskBaselineSignature(disk))
  }
  const edit = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  const tab = (id: string) => store.getState().openFiles.find((file) => file.id === id)
  return { store, a, b, edit, tab }
}

type ClickAction = { onClick: () => void }

function isClickAction(value: unknown): value is ClickAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    'onClick' in value &&
    typeof value.onClick === 'function'
  )
}

describe('two tabs sharing one model', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('Reload discards both drafts and reloads both tabs', () => {
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    edit(b.id, 'mine')
    for (const id of [a.id, b.id]) {
      store.getState().setExternalMutation(id, 'changed')
    }
    const reloadContent = vi.fn()

    reloadTabContentFromDisk(store.getState().openFiles[0], reloadContent)

    expect(reloadContent.mock.calls.map(([file]) => file.id).sort()).toEqual([a.id, b.id].sort())
    for (const id of [a.id, b.id]) {
      expect(store.getState().editorDrafts[id]).toBeUndefined()
      expect(tab(id)?.externalMutation).toBeUndefined()
    }
  })

  it("Reload from a clean tab offers Undo of the sibling's discarded edits", () => {
    const { store, a, b, edit } = openSharedTabs('A')
    edit(b.id, 'mine')
    for (const id of [a.id, b.id]) {
      store.getState().setExternalMutation(id, 'changed')
    }
    const toastMock = vi.mocked(toast)
    toastMock.mockClear()
    reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
    expect(store.getState().editorDrafts[b.id]).toBeUndefined()

    const undo: unknown = toastMock.mock.calls[0]?.[1]?.action
    expect(isClickAction(undo)).toBe(true)
    if (isClickAction(undo)) {
      undo.onClick()
    }

    expect(store.getState().editorDrafts[b.id]).toBe('mine')
  })

  it.each([
    ['in the other workspace', false],
    ['in the other workspace while it shows the Changes view', true]
  ])('Undo of Reload yields to typing since %s, on every view', (_name, changesView) => {
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    const toastMock = vi.mocked(toast)
    toastMock.mockClear()
    reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
    if (changesView) {
      // Changes uses the same record, so switching views must not change sharing.
      store.getState().setEditorViewMode(b.id, 'changes')
    }
    edit(b.id, 'typed after reload')

    const undo: unknown = toastMock.mock.calls[0]?.[1]?.action
    expect(isClickAction(undo)).toBe(true)
    if (isClickAction(undo)) {
      undo.onClick()
    }

    expect(store.getState().editorDrafts[a.id]).toBe('typed after reload')
    expect(store.getState().editorDrafts[b.id]).toBe('typed after reload')
    expect(tab(b.id)?.externalMutation).toBeUndefined()
  })
})
