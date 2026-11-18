import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createEditorStore } from '@/components/editor/autosave/editor-autosave-controller-test-fixture'
import {
  openGuardedFile,
  GUARDED_PATH
} from '@/components/editor/save/queue/editor-save-guarded-disk-fixture'
import '../../../../../../shared/settings/global-settings-test-fixture'
import {
  __clearSelfWriteRegistryForTests,
  recordSelfWrite
} from '@/components/editor/external-changes/editor-self-write-registry'

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
