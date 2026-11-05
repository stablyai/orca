// Don’t Save must void queued saves, including requests waiting on the remote host before writing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave } from '../../autosave/editor-autosave'
import { attachEditorAutosaveController } from '../../autosave/editor-autosave-controller'
import {
  discardEditorBuffer,
  discardEditorFileChangesAndClose
} from './discard-editor-file-changes'
import { registerPendingEditorFlush } from './editor-pending-flush'

import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import type * as MutationClient from '@/runtime/runtime-file-mutation-client'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines,
  type FakeEditorDisk
} from '../../autosave/editor-autosave-controller-test-fixture'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
// Hold the remote capability/status round trip before bytes are sent.
const hostCheck = vi.hoisted((): { wait: Promise<void> | null } => ({ wait: null }))
vi.mock('@/runtime/runtime-file-mutation-client', async (importOriginal) => {
  const actual = await importOriginal<typeof MutationClient>()
  return {
    ...actual,
    writeRuntimeFile: async (...args: Parameters<typeof actual.writeRuntimeFile>) => {
      await hostCheck.wait
      return actual.writeRuntimeFile(...args)
    }
  }
})

const PATH = '/repo/a.ts'

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

function holdNextWrite(disk: FakeEditorDisk): () => void {
  const { wait, open } = gate()
  // Why: the held write is always the first, so it lands unconditionally.
  disk.fs.writeFile.mockImplementationOnce(
    async ({ filePath, content }: { filePath: string; content: string }) => {
      await wait
      disk.files.set(filePath, content)
      return { ok: true }
    }
  )
  return open
}

describe("Don't Save against running and queued saves", () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let detach: () => void

  const edit = (text: string): void => {
    store.getState().setEditorDraft(PATH, text)
    store.getState().markFileDirty(PATH, true)
  }
  const written = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => args.content)

  function setUp(files: Record<string, string>): void {
    disk = stubEditorWindowWithDisk(createFakeEditorDisk(files))
    store = createEditorStore()
    storeRef.current = store
    store.setState({
      browserTabsByWorktree: {},
      tabsByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })
    store.getState().openFile({
      filePath: PATH,
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    withLoadedBaselines(store, createFakeEditorDisk({ [PATH]: '' }))
    detach = attachEditorAutosaveController(store)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setUp({ [PATH]: '' })
  })

  afterEach(() => {
    hostCheck.wait = null
    detach()
    vi.useRealTimers()
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
  })

  it('keeps the running save and never writes the queued newest text', async () => {
    edit('a')
    const release = holdNextWrite(disk)
    const running = requestEditorFileSave({ fileId: PATH })
    await vi.advanceTimersByTimeAsync(0)
    edit('ab')
    const queued = requestEditorFileSave({ fileId: PATH })

    const discard = discardEditorFileChangesAndClose(PATH)
    release()
    await Promise.all([running, queued, discard])

    expect(written()).toEqual(['a'])
    expect(disk.files.get(PATH)).toBe('a')
  })

  it('keeps the running save and never writes a queued autosave', async () => {
    edit('a')
    const release = holdNextWrite(disk)
    const running = requestEditorFileSave({ fileId: PATH })
    await vi.advanceTimersByTimeAsync(0)
    edit('ab')
    // The autosave timer fires and queues behind the running save.
    await vi.advanceTimersByTimeAsync(1000)

    const discard = discardEditorFileChangesAndClose(PATH)
    release()
    await Promise.all([running, discard])
    await vi.advanceTimersByTimeAsync(5000)

    expect(written()).toEqual(['a'])
    expect(disk.files.get(PATH)).toBe('a')
  })

  it("a notebook republishing its retained cells after Don't Save writes nothing", async () => {
    edit('a')
    const release = holdNextWrite(disk)
    const running = requestEditorFileSave({ fileId: PATH })
    await vi.advanceTimersByTimeAsync(0)
    edit('ab')
    const queued = requestEditorFileSave({ fileId: PATH })
    // Match retained notebook drafts that republish discarded cells on flush.
    const unregister = registerPendingEditorFlush(PATH, () => edit('cells'))
    try {
      const discard = discardEditorFileChangesAndClose(PATH)
      release()
      await Promise.all([running, queued, discard])
      await vi.advanceTimersByTimeAsync(5000)
    } finally {
      unregister()
    }

    expect(written()).toEqual(['a'])
  })

  it('a save asked for after the discard still writes', async () => {
    edit('a')
    const release = await discardEditorBuffer(PATH)
    release()
    edit('fresh')
    await requestEditorFileSave({ fileId: PATH })

    expect(disk.files.get(PATH)).toBe('fresh')
  })

  it('a view republishing the dropped text during the drain gets no autosave', async () => {
    edit('a')
    const release = holdNextWrite(disk)
    const running = requestEditorFileSave({ fileId: PATH })
    await vi.advanceTimersByTimeAsync(0)

    const discard = discardEditorFileChangesAndClose(PATH)
    // A mounted rich or notebook view restores its cells while the running save drains.
    edit('cells')
    await vi.advanceTimersByTimeAsync(2000)
    release()
    await Promise.all([running, discard])
    await vi.advanceTimersByTimeAsync(5000)

    expect(written()).toEqual(['a'])
  })
})
