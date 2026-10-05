import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type {
  EditorRecoveryAck,
  EditorRecoveryApi,
  EditorRecoveryChange
} from '../../../shared/editor-recovery'
import { createEditorRecoverySubscriber } from './editor-recovery-subscriber'
import { getEditorRecoveryCheckpoint } from './editor-recovery-checkpoints'

let original: AppState
const subscribers: ReturnType<typeof createEditorRecoverySubscriber>[] = []
beforeEach(() => {
  original = useAppStore.getState()
  vi.useFakeTimers()
  useAppStore.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    openFiles: [],
    editorDrafts: {}
  })
})
afterEach(() => {
  for (const subscriber of subscribers.splice(0)) {
    subscriber.dispose()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  useAppStore.setState(original, true)
})
function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'note',
    filePath: '/same/note.txt',
    relativePath: 'note.txt',
    worktreeId: 'folder:one',
    language: 'plaintext',
    isDirty: true,
    mode: 'edit',
    ...overrides
  }
}
function fixture(files = [file()], drafts: Record<string, string> = { note: 'initial' }) {
  useAppStore.setState({ openFiles: files, editorDrafts: drafts })
  const appliedAt: number[] = []
  const apply = vi.fn<EditorRecoveryApi['apply']>(async (changes) => {
    appliedAt.push(Date.now())
    return changes.map((change) => ({ id: change.id, revision: change.expectedRevision + 1 }))
  })
  const api: EditorRecoveryApi = {
    apply,
    list: async () => [],
    read: async () => null,
    export: async () => null
  }
  const onError = vi.fn()
  const flushPendingChanges = vi.fn()
  const subscriber = createEditorRecoverySubscriber({
    store: useAppStore,
    api,
    onError,
    flushPendingChanges
  })
  subscribers.push(subscriber)
  const changes = (): EditorRecoveryChange[] => apply.mock.calls.flatMap(([batch]) => batch)
  return { subscriber, api, apply, onError, flushPendingChanges, appliedAt, changes }
}
function deferred<T>() {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    resolve: (value: T) => {
      if (!settle) {
        throw new Error('Missing resolver')
      }
      settle(value)
    }
  }
}

describe('buffer checkpoints independent of layout persistence', () => {
  it('backs up throughout continuous typing and leaves idle or unrelated state changes free of writes', async () => {
    const f = fixture()
    for (let index = 0; index < 50; index++) {
      useAppStore.getState().setEditorDraft('note', `edit-${index}`)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(f.appliedAt.length).toBeGreaterThanOrEqual(5)
    expect(f.appliedAt.length).toBeLessThanOrEqual(10)
    for (let index = 1; index < f.appliedAt.length; index++) {
      expect((f.appliedAt[index] ?? 0) - (f.appliedAt[index - 1] ?? 0)).toBeLessThanOrEqual(500)
    }
    expect(f.changes().at(-1)).toMatchObject({ kind: 'put', content: 'edit-49', state: 'active' })
    const writes = f.apply.mock.calls.length
    for (let index = 0; index < 100; index++) {
      useAppStore.setState({ sidebarWidth: 250 + index })
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.apply).toHaveBeenCalledTimes(writes)
  })

  it('captures the latest text before a tab or workspace removes the draft, even before the first timer fires', async () => {
    const f = fixture()
    useAppStore.getState().setEditorDraft('note', 'last edit before closing')
    useAppStore.setState({ openFiles: [], editorDrafts: {}, folderWorkspaces: [] })
    await f.subscriber.flush()
    expect(f.changes()).toEqual([
      expect.objectContaining({
        kind: 'put',
        content: 'last edit before closing',
        state: 'retained'
      })
    ])
    expect(getEditorRecoveryCheckpoint('note')).toBeUndefined()
  })

  it('retains a clean-looking replacement and resolves only a matching verified save or an explicit discard', async () => {
    const f = fixture()
    await f.subscriber.flush()
    useAppStore.setState({ openFiles: [file({ isDirty: false })], editorDrafts: {} })
    const saved = f.subscriber.resolve('note', 'initial')
    await saved
    expect(f.changes().at(-1)).toMatchObject({ kind: 'resolve', expectedRevision: 1 })

    useAppStore.setState({ openFiles: [file()], editorDrafts: { note: 'new unsaved text' } })
    await f.subscriber.flush()
    await f.subscriber.resolve('note', 'initial')
    expect(f.changes().at(-1)).toMatchObject({ kind: 'put', content: 'new unsaved text' })
    await f.subscriber.resolve('note')
    expect(f.changes().at(-1)?.kind).toBe('resolve')
  })

  it('preserves a topology reset that clears dirty flags without a verified save', async () => {
    const f = fixture()
    await f.subscriber.flush()
    useAppStore.setState({ openFiles: [file({ isDirty: false })], editorDrafts: {} })
    await f.subscriber.flush()
    expect(f.changes().at(-1)?.kind).toBe('retain')
    expect(f.changes().some((change) => change.kind === 'resolve')).toBe(false)
  })

  it('fences a verified save that arrives before the first checkpoint is dispatched', async () => {
    const f = fixture()
    const checkpoint = getEditorRecoveryCheckpoint('note')
    useAppStore.setState({ openFiles: [file({ isDirty: false })], editorDrafts: {} })
    await f.subscriber.resolve('note', 'initial')
    expect(f.changes()).toEqual([{ kind: 'resolve', id: checkpoint?.id, expectedRevision: 0 }])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('coalesces edits behind an in-flight write and never lets its older acknowledgement erase them', async () => {
    const f = fixture()
    const blocked = deferred<EditorRecoveryAck[]>()
    f.apply.mockImplementationOnce(() => blocked.promise)
    const first = f.subscriber.flush()
    const firstChange = f.changes()[0]
    if (!firstChange) {
      throw new Error('First checkpoint was not dispatched')
    }
    for (let index = 0; index < 100; index++) {
      useAppStore.getState().setEditorDraft('note', `latest-${index}`)
    }
    const staleSave = f.subscriber.resolve('note', 'initial')
    useAppStore.setState({ openFiles: [], editorDrafts: {} })
    const closing = f.subscriber.flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    blocked.resolve([{ id: firstChange.id, revision: 1 }])
    await Promise.all([first, staleSave, closing])
    expect(f.apply).toHaveBeenCalledTimes(2)
    expect(f.changes().at(-1)).toMatchObject({
      kind: 'put',
      expectedRevision: 1,
      content: 'latest-99',
      state: 'retained'
    })
  })

  it('retries the newest text after a disk failure and refuses malformed durability acknowledgements', async () => {
    const f = fixture()
    f.apply.mockRejectedValueOnce(new Error('disk is full'))
    await expect(f.subscriber.flush()).rejects.toThrow('disk is full')
    useAppStore.getState().setEditorDraft('note', 'newer while storage was unavailable')
    await f.subscriber.flush()
    expect(f.changes().at(-1)).toMatchObject({
      kind: 'put',
      expectedRevision: 0,
      content: 'newer while storage was unavailable'
    })
    useAppStore.getState().setEditorDraft('note', 'final')
    f.apply.mockImplementationOnce(async (changes) =>
      changes.map((change) => ({ id: change.id, revision: 99 }))
    )
    await expect(f.subscriber.flush()).rejects.toThrow('Invalid recovery write acknowledgement')
    await f.subscriber.flush()
    expect(f.changes().at(-1)).toMatchObject({ kind: 'put', content: 'final', expectedRevision: 1 })
  })

  it('splits large drafts without truncating them or losing edits behind an acknowledgement', async () => {
    const large = 'a'.repeat(2 * 1024 * 1024)
    const oversized = '\uD83D\uDE00'.repeat((3 * 1024 * 1024) / 2)
    const f = fixture(
      ['first', 'second', 'oversized'].map((id) => file({ id, filePath: `/same/${id}.txt` })),
      { first: large, second: large, oversized }
    )
    const blocked = deferred<EditorRecoveryAck[]>()
    f.apply.mockImplementationOnce(() => blocked.promise)
    const first = f.subscriber.flush()
    expect(f.changes()).toHaveLength(1)
    const firstChange = f.changes()[0]
    if (!firstChange) {
      throw new Error('First large checkpoint missing')
    }
    useAppStore.getState().setEditorDraft('first', `${large}new first`)
    useAppStore.getState().setEditorDraft('second', `${large}new second`)
    const latest = f.subscriber.flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    blocked.resolve([{ id: firstChange.id, revision: 1 }])
    await Promise.all([first, latest])
    expect(f.apply.mock.calls.map(([changes]) => changes.length)).toEqual([1, 1, 1, 1])
    expect(f.changes()).toEqual([
      expect.objectContaining({ content: large, expectedRevision: 0 }),
      expect.objectContaining({ content: `${large}new second`, expectedRevision: 0 }),
      expect.objectContaining({ content: oversized, expectedRevision: 0 }),
      expect.objectContaining({
        id: firstChange.id,
        kind: 'patch',
        inserted: 'new first',
        baseLength: large.length,
        expectedRevision: 1
      })
    ])
    expect(f.onError).not.toHaveBeenCalled()
  })

  it('batches small edits to large drafts and bases queued patches on acknowledged text', async () => {
    const large = 'a'.repeat(2 * 1024 * 1024)
    const f = fixture(
      ['one', 'two'].map((id) => file({ id })),
      { one: large, two: large }
    )
    await f.subscriber.flush()
    f.apply.mockClear()
    const blocked = deferred<EditorRecoveryAck[]>()
    f.apply.mockImplementationOnce(() => blocked.promise)
    useAppStore.setState({ editorDrafts: { one: `${large}first`, two: `${large}second` } })
    const writing = f.subscriber.flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.changes()).toEqual([
      expect.objectContaining({ kind: 'patch', inserted: 'first', expectedRevision: 1 }),
      expect.objectContaining({ kind: 'patch', inserted: 'second', expectedRevision: 1 })
    ])
    useAppStore.setState({ editorDrafts: { one: `${large}first!`, two: `${large}second` } })
    const latest = f.subscriber.flush()
    blocked.resolve(f.changes().map((change) => ({ id: change.id, revision: 2 })))
    await Promise.all([writing, latest])
    expect(f.changes().at(-1)).toMatchObject({
      kind: 'patch',
      baseLength: large.length + 5,
      start: large.length + 5,
      inserted: '!',
      removed: 0,
      expectedRevision: 2
    })
    useAppStore.setState({ openFiles: [], editorDrafts: {} })
    await f.subscriber.flush()
    expect(
      f
        .changes()
        .slice(-2)
        .map((change) => change.kind)
    ).toEqual(['retain', 'retain'])
  })

  it('keeps text entered while retirement is pending under a fresh checkpoint', async () => {
    const f = fixture()
    await f.subscriber.flush()
    const original = f.changes()[0]
    if (!original) {
      throw new Error('Initial checkpoint missing')
    }
    const blocked = deferred<EditorRecoveryAck[]>()
    f.apply.mockImplementationOnce(() => blocked.promise)
    const retiring = f.subscriber.resolve('note')
    useAppStore.getState().setEditorDraft('note', 'typed while retirement was pending')
    const latest = f.subscriber.flush()
    blocked.resolve([{ id: original.id, revision: 2 }])
    await Promise.all([retiring, latest])
    const checkpoint = f.changes().at(-1)
    expect(checkpoint).toMatchObject({
      kind: 'put',
      expectedRevision: 0,
      state: 'active',
      content: 'typed while retirement was pending'
    })
    expect(checkpoint?.id).not.toBe(original.id)
    expect(getEditorRecoveryCheckpoint('note')?.id).toBe(checkpoint?.id)
  })

  it('does not alter recovery state while hydration is incomplete or failed', async () => {
    useAppStore.setState({ hydrationSucceeded: false })
    const f = fixture()
    await f.subscriber.flush()
    expect(f.apply).not.toHaveBeenCalled()
    useAppStore.setState({ hydrationSucceeded: true })
    await f.subscriber.flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    useAppStore.setState({ hydrationSucceeded: false, openFiles: [], editorDrafts: {} })
    await f.subscriber.flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('retains the previous owner when a buffer ID is reused for a different remote target', async () => {
    const f = fixture([file({ externalSshTargetId: 'first-host' })])
    await f.subscriber.flush()
    const first = f.changes()[0]
    useAppStore.setState({
      openFiles: [file({ externalSshTargetId: 'second-host' })],
      editorDrafts: { note: 'second host edit' }
    })
    await f.subscriber.flush()
    expect(f.changes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'retain', id: first?.id }),
        expect.objectContaining({
          kind: 'put',
          content: 'second host edit',
          metadata: expect.objectContaining({ hostId: 'ssh:second-host' })
        })
      ])
    )
    expect(f.changes().at(-1)?.id).not.toBe(first?.id)
  })

  it('protects editable diff and empty drafts while excluding staged and read-only surfaces', async () => {
    const f = fixture(
      [
        file(),
        file({ id: 'diff', mode: 'diff', diffSource: 'unstaged' }),
        file({ id: 'staged', mode: 'diff', diffSource: 'staged' }),
        file({ id: 'log', readOnly: true }),
        file({ id: 'remote', runtimeEnvironmentId: 'remote', externalSshTargetId: 'host' })
      ],
      { note: '', diff: 'diff edit', staged: 'immutable', log: 'immutable', remote: 'remote text' }
    )
    await f.subscriber.flush()
    const puts = f.changes().filter((change) => change.kind === 'put')
    expect(puts).toHaveLength(3)
    expect(puts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: '',
          metadata: expect.objectContaining({ hostId: 'local', bufferKind: 'edit' })
        }),
        expect.objectContaining({
          content: 'diff edit',
          metadata: expect.objectContaining({ bufferKind: 'diff' })
        }),
        expect.objectContaining({
          content: 'remote text',
          metadata: expect.objectContaining({ hostId: 'ssh:host', runtimeEnvironmentId: 'remote' })
        })
      ])
    )
  })

  it('adopts durable restored buffers without rewriting them and checkpoints only the changed buffer among many tabs', async () => {
    const files = Array.from({ length: 2_000 }, (_, index) =>
      file({ id: `tab-${index}`, isDirty: false })
    )
    files.push(file({ recoveryId: 'restored-buffer', recoveryRevision: 7 }))
    const f = fixture(files)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.apply).not.toHaveBeenCalled()
    useAppStore.getState().setEditorDraft('note', 'updated')
    await f.subscriber.flush()
    expect(f.changes()).toEqual([
      expect.objectContaining({ id: 'restored-buffer', expectedRevision: 7, content: 'updated' })
    ])
  })
})
