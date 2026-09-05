import { beforeEach, describe, expect, it, vi } from 'vitest'
const database = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn()
}))
vi.mock('./creation-draft-database', () => database)
import {
  bindCreationDraft,
  discardCreationDraft,
  editCreationDraft,
  flushCreationDraft,
  loadCreationDrafts,
  useCreationDraftSession
} from './creation-draft-session'
import type { CreationDraft, CreationDraftInput } from './creation-draft-record'
const draft = (text: string, id = 'create-1'): CreationDraftInput => ({
  id,
  text,
  title: 'Workspace',
  agent: 'codex',
  executionHostId: 'local',
  updatedAt: 1
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  useCreationDraftSession.setState({
    entries: {},
    loaded: false,
    loadError: null,
    viewedDraftId: null
  })
  database.listDrafts.mockResolvedValue([])
  database.saveDraft.mockImplementation(
    async (input: CreationDraftInput, revision: number | null) => ({
      ...input,
      revision: (revision ?? 0) + 1
    })
  )
})
describe('creation draft session ownership', () => {
  it('keeps edits and workspace binding made while an earlier save is pending', async () => {
    const first = deferred<CreationDraft>()
    database.saveDraft.mockImplementationOnce(() => first.promise)
    editCreationDraft(draft('first'))
    await Promise.resolve()
    editCreationDraft(draft('second'))
    bindCreationDraft('create-1', { worktreeId: 'workspace-1', terminalHandle: 'original' })
    first.resolve({ ...draft('first'), revision: 1 })
    await flushCreationDraft('create-1')
    const entry = useCreationDraftSession.getState().entries['create-1']
    expect(entry.buffer).toMatchObject({
      text: 'second',
      target: { worktreeId: 'workspace-1', terminalHandle: 'original' }
    })
    expect(entry.savedVersion).toBe(entry.editVersion)
    expect(database.saveDraft).toHaveBeenLastCalledWith(entry.buffer, 1)
  })
  it('does not let late hydration replace text typed in the current window', async () => {
    const loading = deferred<CreationDraft[]>()
    database.listDrafts.mockReturnValue(loading.promise)
    const load = loadCreationDrafts()
    editCreationDraft(draft('current'))
    await flushCreationDraft('create-1')
    loading.resolve([
      { ...draft('older'), revision: 1 },
      { ...draft('other window', 'create-2'), revision: 1 }
    ])
    await load
    expect(useCreationDraftSession.getState().entries['create-1'].buffer.text).toBe('current')
    expect(useCreationDraftSession.getState().entries['create-2'].buffer.text).toBe('other window')
  })
  it('keeps unsaved text after failure and only retries when requested', async () => {
    database.saveDraft.mockRejectedValueOnce(new Error('disk unavailable'))
    editCreationDraft(draft('keep me'))
    await flushCreationDraft('create-1')
    expect(database.saveDraft).toHaveBeenCalledOnce()
    expect(useCreationDraftSession.getState().entries['create-1']).toMatchObject({
      buffer: { text: 'keep me' },
      error: 'disk unavailable',
      savedVersion: 0
    })
    await flushCreationDraft('create-1')
    expect(useCreationDraftSession.getState().entries['create-1']).toMatchObject({
      error: null,
      storedRevision: 1
    })
  })
  it('does not discard newer text typed during a pending deletion', async () => {
    editCreationDraft(draft('old'))
    await flushCreationDraft('create-1')
    const deletion = deferred<void>()
    database.deleteDraft.mockReturnValue(deletion.promise)
    const removing = discardCreationDraft('create-1')
    await Promise.resolve()
    editCreationDraft(draft('newer'))
    await flushCreationDraft('create-1')
    deletion.resolve()
    await removing
    const entry = useCreationDraftSession.getState().entries['create-1']
    expect(entry.buffer.text).toBe('newer')
    expect(entry.savedVersion).toBe(entry.editVersion)
    expect(database.saveDraft).toHaveBeenLastCalledWith(entry.buffer, null)
  })
})

it('discovers other-window drafts on refresh without replacing local edits', async () => {
  await loadCreationDrafts()
  editCreationDraft(draft('local text'))
  await flushCreationDraft('create-1')
  database.listDrafts.mockResolvedValue([
    { ...draft('other window replacement'), revision: 2 },
    { ...draft('new draft', 'create-2'), revision: 1 }
  ])
  await loadCreationDrafts()
  expect(database.listDrafts).toHaveBeenCalledTimes(1)
  await loadCreationDrafts(true)
  expect(useCreationDraftSession.getState().entries['create-1'].buffer.text).toBe('local text')
  expect(useCreationDraftSession.getState().entries['create-2'].buffer.text).toBe('new draft')
})

it('reconciles external draft replacement without accumulating removed records', async () => {
  for (let generation = 0; generation < 3; generation++) {
    database.listDrafts.mockResolvedValue(
      Array.from({ length: 64 }, (_, index) => ({
        ...draft('external', `${generation}-${index}`),
        revision: 1
      }))
    )
    await loadCreationDrafts(true)
    expect(Object.keys(useCreationDraftSession.getState().entries)).toHaveLength(64)
  }
})

it('preserves the open recovered draft when another writer deletes it', async () => {
  database.listDrafts.mockResolvedValue([{ ...draft('keep open'), revision: 1 }])
  await loadCreationDrafts()
  useCreationDraftSession.setState({ viewedDraftId: 'create-1' })
  database.listDrafts.mockResolvedValue([])
  await loadCreationDrafts(true)
  expect(useCreationDraftSession.getState().entries['create-1'].buffer.text).toBe('keep open')
  useCreationDraftSession.setState({ viewedDraftId: null })
  await loadCreationDrafts(true)
  expect(useCreationDraftSession.getState().entries).toEqual({})
})

it('retains discovered buffer identity and revision when the database record changes', async () => {
  database.listDrafts.mockResolvedValue([{ ...draft('original'), revision: 1 }])
  await loadCreationDrafts()
  const original = useCreationDraftSession.getState().entries['create-1']
  database.listDrafts.mockResolvedValue([{ ...draft('external update'), revision: 2 }])
  await loadCreationDrafts(true)
  expect(useCreationDraftSession.getState().entries['create-1']).toBe(original)
  expect(original.storedRevision).toBe(1)
})
