import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createEditorStore } from '@/components/editor/editor-autosave-controller-test-fixture'
import { openGuardedFile, GUARDED_PATH } from '@/components/editor/editor-save-guarded-disk-fixture'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  __clearSelfWriteRegistryForTests,
  recordSelfWrite
} from '@/components/editor/editor-self-write-registry'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))

import { reconcileEditorTabsAfterOverflow } from './editor-external-watch-overflow'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  __clearSelfWriteRegistryForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['original', 'external rewrite'])(
  'compares a dirty tab after an unwatched period with autosave off (%s)',
  async (content) => {
    const store = createEditorStore()
    storeRef.current = store
    store.setState({ settings: createGlobalSettingsFixture({ editorAutoSave: false }) })
    openGuardedFile(store, { baseline: 'original', draft: 'my edits' })
    let finishRead: () => void = () => undefined
    const readFile = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRead = () => resolve({ content, isBinary: false })
        })
    )
    const writeFile = vi.fn()
    vi.stubGlobal('window', { api: { fs: { readFile, writeFile } } })

    reconcileEditorTabsAfterOverflow({ worktreeId: 'wt-1', worktreePath: '/repo' }, true)
    expect(readFile).toHaveBeenCalled()
    expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
    store.getState().setEditorDraft(GUARDED_PATH, 'still typing')
    finishRead()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getState().openFiles[0]?.externalMutation).toBe(
      content === 'original' ? undefined : 'changed'
    )
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    expect(store.getState().editorDrafts[GUARDED_PATH]).toBe('still typing')
    expect(writeFile).not.toHaveBeenCalled()
  }
)

it('leaves a dirty tab unmarked when its resync read fails', async () => {
  const store = createEditorStore()
  storeRef.current = store
  openGuardedFile(store, { baseline: 'original', draft: 'my edits' })
  const readFile = vi.fn(() => Promise.reject(new Error('connection lost')))
  vi.stubGlobal('window', { api: { fs: { readFile } } })

  reconcileEditorTabsAfterOverflow({ worktreeId: 'wt-1', worktreePath: '/repo' }, true)
  await vi.advanceTimersByTimeAsync(0)

  expect(readFile).toHaveBeenCalled()
  expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
})

it("treats the tab's own just-written save as an echo, not an external change", async () => {
  const store = createEditorStore()
  storeRef.current = store
  openGuardedFile(store, { baseline: 'original', draft: 'my edits' })
  recordSelfWrite(GUARDED_PATH, 'saved edits')
  vi.stubGlobal('window', {
    api: { fs: { readFile: vi.fn(async () => ({ content: 'saved edits', isBinary: false })) } }
  })

  reconcileEditorTabsAfterOverflow({ worktreeId: 'wt-1', worktreePath: '/repo' }, true)
  await vi.advanceTimersByTimeAsync(0)

  expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
})
