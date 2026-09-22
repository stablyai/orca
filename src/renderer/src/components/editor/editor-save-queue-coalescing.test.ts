import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from './editor-autosave'
import { createEditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

function deferred() {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup() {
  const write = stubEditorWindow()
  const store = createEditorStore()
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Missing test settings')
  }
  store.setState({
    settings: { ...settings, editorAutoSave: false },
    worktreesByRepo: {
      'repo-1': store.getState().worktreesByRepo['repo-1'].map((worktree) => ({
        ...worktree,
        path: '/repo'
      }))
    }
  })
  const fileId = store.getState().openFile({
    filePath: '/repo/file.txt',
    relativePath: 'file.txt',
    worktreeId: 'wt-1',
    mode: 'edit',
    language: 'text'
  })
  const file = store.getState().openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    throw new Error('Missing test file')
  }
  const queue = createEditorSaveQueue(store)
  const saved: unknown[] = []
  window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, (event) => {
    if (event instanceof CustomEvent) {
      saved.push(event.detail)
    }
  })
  return { write, store, file, queue, saved }
}

describe('coalesced editor saves', () => {
  afterEach(() => {
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
  })

  it('acknowledges pending requests only after the latest content is written and emits exact saved content', async () => {
    const { write, file, queue, saved } = setup()
    const firstWrite = deferred(),
      latestWrite = deferred()
    write.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(latestWrite.promise)
    const first = queue.queueSave(file, 'first')
    await nextTurn()
    const older = queue.queueSave(file, 'superseded')
    const latest = queue.queueSave(file, 'latest')
    let acknowledged = false
    const all = Promise.all([older, latest]).then(() => {
      acknowledged = true
    })
    try {
      firstWrite.resolve()
      await first
      await nextTurn()
      expect(acknowledged).toBe(false)
      expect(write.mock.calls.map(([args]) => args.content)).toEqual(['first', 'latest'])
      expect(saved).toEqual([{ fileId: file.id, content: 'first' }])
    } finally {
      firstWrite.resolve()
      latestWrite.resolve()
      await Promise.all([first, all])
      queue.dispose()
    }
    expect(saved).toEqual([
      { fileId: file.id, content: 'first' },
      { fileId: file.id, content: 'latest' }
    ])
  })

  it.each([
    ['user', 'autosave'],
    ['autosave', 'user'],
    ['autosave', 'autosave']
  ] as const)(
    'preserves %s then %s priority when a conflict blocks autosave',
    async (firstTrigger, lastTrigger) => {
      const { write, store, file, queue } = setup()
      const blocked = deferred()
      write.mockReturnValueOnce(blocked.promise)
      const first = queue.queueSave(file, 'first')
      await nextTurn()
      const pending = queue.queueSave(file, 'older', firstTrigger)
      const latest = queue.queueSave(file, 'latest', lastTrigger)
      const conflict = first.then(() => store.getState().setExternalMutation(file.id, 'changed'))
      blocked.resolve()
      await Promise.all([first, pending, latest, conflict])
      const expectsWrite = firstTrigger === 'user' || lastTrigger === 'user'
      expect(write.mock.calls.map(([args]) => args.content)).toEqual(
        expectsWrite ? ['first', 'latest'] : ['first']
      )
      queue.dispose()
    }
  )

  it('lets the latest queued save recover after an earlier write fails', async () => {
    const { write, file, queue, saved } = setup()
    const blocked = deferred()
    write.mockReturnValueOnce(blocked.promise)
    const failure = new Error('first write failed')
    const first = queue.queueSave(file, 'first').catch((error: unknown) => error)
    await nextTurn()
    const pending = queue.queueSave(file, 'older')
    const latest = queue.queueSave(file, 'latest')
    blocked.reject(failure)
    expect(await first).toBe(failure)
    await Promise.all([pending, latest])
    expect(saved).toEqual([{ fileId: file.id, content: 'latest' }])
    queue.dispose()
  })

  it('propagates a trailing write failure to every joined request without a saved event', async () => {
    const { write, file, queue, saved } = setup()
    const blocked = deferred()
    const failure = new Error('disk full')
    write.mockReturnValueOnce(blocked.promise).mockRejectedValueOnce(failure)
    const first = queue.queueSave(file, 'first')
    await nextTurn()
    const pending = queue.queueSave(file, 'older').catch((error: unknown) => error)
    const latest = queue.queueSave(file, 'latest').catch((error: unknown) => error)
    blocked.resolve()
    await first
    expect(await Promise.all([pending, latest])).toEqual([failure, failure])
    expect(saved).toEqual([{ fileId: file.id, content: 'first' }])
    queue.dispose()
  })

  it('quiesces the active write and discards pending content before an owner migration', async () => {
    const { write, store, file, queue, saved } = setup()
    const blocked = deferred()
    write.mockReturnValueOnce(blocked.promise)
    const first = queue.queueSave(file, 'first')
    await nextTurn()
    store.getState().setEditorDraft(file.id, 'unsaved latest')
    const pending = queue.queueSave(file, 'obsolete fallback')
    let quiesced = false
    const drain = queue.quiesceFileSave(file.id).then(() => {
      quiesced = true
    })
    await nextTurn()
    expect(quiesced).toBe(false)
    blocked.resolve()
    await Promise.all([first, pending, drain])
    expect(write).toHaveBeenCalledTimes(1)
    expect(saved).toEqual([])
    expect(store.getState().editorDrafts[file.id]).toBe('unsaved latest')
    queue.dispose()
  })

  it('keeps new-generation saves separate from invalidated pending saves', async () => {
    const { write, file, queue, saved } = setup()
    const blocked = deferred()
    write.mockReturnValueOnce(blocked.promise)
    const first = queue.queueSave(file, 'first')
    await nextTurn()
    const old = queue.queueSave(file, 'old generation')
    queue.bumpSaveGeneration(file.id)
    const current = queue.queueSave(file, 'new generation')
    blocked.resolve()
    await Promise.all([first, old, current])
    expect(write.mock.calls.map(([args]) => args.content)).toEqual(['first', 'new generation'])
    expect(saved).toEqual([{ fileId: file.id, content: 'new generation' }])
    queue.dispose()
  })
})
