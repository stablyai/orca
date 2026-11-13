import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createEditorSaveQueue } from '../queue/editor-save-queue'
import type { EditorSaveQueue } from '../queue/editor-save-queue-contract'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from '../../autosave/editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import { registerPendingEditorFlush } from '../flush/editor-pending-flush'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'

import { discardEditorGenerations, EditorSaveDiscardedError } from '../flush/editor-discard-epoch'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('format on the guarded save path', () => {
  let disk: ReturnType<typeof createFakeEditorDisk>
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue
  const file = () => store.getState().openFiles[0]
  const edit = (text: string): void => {
    store.getState().setEditorDraft('a', text)
    store.getState().markFileDirty('a', true)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ '/repo/a.ts': '' }))
    store = createEditorStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
      },
      settings: { ...store.getState().settings!, editorFormatOnSave: true },
      openFiles: [
        {
          id: 'a',
          filePath: '/repo/a.ts',
          relativePath: 'a.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })
    withLoadedBaselines(store, disk)
    usePluginPanelsStore.setState({ plugins: [] })
    vi.mocked(callRuntimeRpc).mockResolvedValue({ kind: 'formatted', text: 'const x = 1\n' })
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
  })

  it.each(['user', 'autosave'] as const)(
    'formats before a %s save and leaves the buffer clean',
    async (trigger) => {
      edit('const x=1')
      expect(await queue.queueSave(file(), 'const x=1', trigger)).toBe('written')
      expect(disk.files.get('/repo/a.ts')).toBe('const x = 1\n')
      expect(file().isDirty).toBe(false)
      expect(callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'files.formatText',
        expect.objectContaining({
          worktree: 'id:wt-1',
          relativePath: 'a.ts',
          content: 'const x=1',
          expectedExecutionHostId: 'local'
        }),
        expect.any(Object)
      )
    }
  )

  it('does not run when disabled or during restart', async () => {
    store.setState({ settings: { ...store.getState().settings!, editorFormatOnSave: false } })
    edit('disabled')
    await queue.queueSave(file(), 'disabled')
    store.setState({ settings: { ...store.getState().settings!, editorFormatOnSave: true } })
    edit('restart')
    await queue.queueSave(file(), 'restart', 'restart')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(disk.files.get('/repo/a.ts')).toBe('restart')
  })

  it('saves original text and surfaces the formatter error without marking a failed save', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('syntax error'))
    edit('invalid syntax')
    expect(await queue.queueSave(file(), 'invalid syntax')).toBe('written')
    expect(disk.files.get('/repo/a.ts')).toBe('invalid syntax')
    expect(file().isDirty).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('syntax error'),
      expect.any(Object)
    )
  })

  it('keeps edits made during formatting dirty while saving only the formatted snapshot', async () => {
    let finish!: (value: { kind: 'formatted'; text: string }) => void
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    edit('one')
    const saving = queue.queueSave(file(), 'one')
    await vi.waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledOnce())
    edit('one two')
    finish({ kind: 'formatted', text: 'ONE' })
    expect(await saving).toBe('written')
    expect(disk.files.get('/repo/a.ts')).toBe('ONE')
    expect(store.getState().editorDrafts.a).toBe('one two')
    expect(file().isDirty).toBe(true)
  })

  it('flushes view-held typing before adopting formatter output', async () => {
    let unregister = (): void => {}
    vi.mocked(callRuntimeRpc).mockImplementationOnce(async () => {
      unregister = registerPendingEditorFlush('a', () => edit('typed meanwhile'))
      return { kind: 'formatted', text: 'ONE' }
    })
    edit('one')
    await queue.queueSave(file(), 'one')
    unregister()
    expect(store.getState().editorDrafts.a).toBe('typed meanwhile')
    expect(file().isDirty).toBe(true)
  })

  it('does not adopt or write a formatter result after the edits were discarded', async () => {
    let finish!: (value: { kind: 'formatted'; text: string }) => void
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    edit('one')
    const saving = queue.queueSave(file(), 'one')
    const rejection = expect(saving).rejects.toBeInstanceOf(EditorSaveDiscardedError)
    await vi.waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledOnce())
    discardEditorGenerations(editorBufferIdOfView(store.getState(), file().id), [file().id])
    finish({ kind: 'formatted', text: 'ONE' })
    await rejection
    expect(disk.files.get('/repo/a.ts')).toBe('')
    expect(store.getState().editorDrafts.a).toBe('one')
  })
  it('still refuses a disk conflict that arrives while the formatter is running', async () => {
    vi.mocked(callRuntimeRpc).mockImplementationOnce(async () => {
      disk.files.set('/repo/a.ts', 'external write')
      return { kind: 'formatted', text: 'ONE' }
    })
    edit('one')
    expect(await queue.queueSave(file(), 'one')).toBe('blocked-stale')
    expect(disk.files.get('/repo/a.ts')).toBe('external write')
    expect(file().externalMutation).toBe('changed')
    expect(file().isDirty).toBe(true)
  })
})
