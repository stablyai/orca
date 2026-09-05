import { beforeEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn()
}))
vi.mock('./creation-draft-database', () => database)
import {
  CreationDraftCapacityError,
  CreationDraftConflictError,
  type CreationDraft,
  type CreationDraftInput
} from './creation-draft-record'
import {
  discardCreationDraft,
  editCreationDraft,
  flushCreationDraft,
  saveCreationDraftCopy,
  useCreationDraftSession
} from './creation-draft-session'

const source: CreationDraftInput = {
  id: 'original',
  title: 'Workspace',
  text: 'Local text',
  agent: 'codex',
  executionHostId: 'local',
  updatedAt: 1,
  target: {
    worktreeId: 'workspace',
    terminalHandle: 'terminal',
    incarnationId: 'incarnation',
    tabId: 'tab'
  },
  delivery: { attemptId: 'attempt', revision: 1, state: 'uncertain' }
}
let records: Map<string, CreationDraft>
const entry = (id = source.id) => useCreationDraftSession.getState().entries[id]
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function save(input: CreationDraftInput, expected: number | null): Promise<CreationDraft> {
  const current = records.get(input.id)
  if ((current?.revision ?? null) !== expected) {
    throw new CreationDraftConflictError(current ?? null)
  }
  const next = { ...input, revision: (expected ?? 0) + 1 }
  records.set(input.id, next)
  return next
}
async function conflict(): Promise<CreationDraft> {
  const other = { ...source, text: 'Other window text', revision: 2 }
  records.set(source.id, other)
  editCreationDraft({ ...source, text: 'My edited text' })
  await flushCreationDraft(source.id)
  expect(entry().conflict).toBe(true)
  return other
}

beforeEach(async () => {
  vi.resetAllMocks()
  records = new Map()
  useCreationDraftSession.setState({
    entries: {},
    loaded: true,
    loadError: null,
    viewedDraftId: null
  })
  database.saveDraft.mockImplementation(save)
  database.deleteDraft.mockImplementation(async (id: string, expected: number) => {
    const current = records.get(id)
    if (current?.revision !== expected) {
      throw new CreationDraftConflictError(current ?? null)
    }
    records.delete(id)
  })
  editCreationDraft(source)
  await flushCreationDraft(source.id)
})

describe('creation draft conflict copies', () => {
  it('preserves the other window record and copies text without a send target or attempt', async () => {
    const other = await conflict()
    const id = await saveCreationDraftCopy(source.id)
    expect(id).not.toBe(source.id)
    expect(records.get(source.id)).toEqual(other)
    expect(records.get(id)).toMatchObject({
      text: 'My edited text',
      target: { worktreeId: 'workspace' }
    })
    expect(records.get(id)?.target).toEqual({ worktreeId: 'workspace' })
    expect(records.get(id)?.delivery).toBeUndefined()
    expect(entry()).toBeUndefined()
    expect(entry(id).conflict).toBeFalsy()
    expect(entry(id).savedVersion).toBe(entry(id).editVersion)
    expect(useCreationDraftSession.getState().viewedDraftId).toBe(id)
    expect(database.deleteDraft).not.toHaveBeenCalled()
  })

  it('commits concurrent edits to the new ID before removing the stale local source', async () => {
    const other = await conflict()
    const gate = deferred()
    database.saveDraft.mockImplementationOnce(async (input, revision) => {
      await gate.promise
      return save(input, revision)
    })
    const copy = saveCreationDraftCopy(source.id)
    await vi.waitFor(() => expect(database.saveDraft).toHaveBeenCalledTimes(3))
    editCreationDraft({ ...entry().buffer, text: 'Newest text' })
    expect(entry().buffer.text).toBe('Newest text')
    gate.resolve()
    const id = await copy
    expect(records.get(id)?.text).toBe('Newest text')
    expect(entry(id).buffer.text).toBe('Newest text')
    expect(records.get(source.id)).toEqual(other)
    expect(database.saveDraft.mock.calls.slice(2).every(([input]) => input.id === id)).toBe(true)
  })

  it('awaits a pending source save and deduplicates simultaneous copy requests', async () => {
    const gate = deferred()
    database.saveDraft.mockImplementationOnce(async (input, revision) => {
      await gate.promise
      return save(input, revision)
    })
    editCreationDraft({ ...source, text: 'Pending save' })
    await Promise.resolve()
    const first = saveCreationDraftCopy(source.id)
    expect(saveCreationDraftCopy(source.id)).toBe(first)
    await Promise.resolve()
    expect(database.saveDraft).toHaveBeenCalledTimes(2)
    gate.resolve()
    const id = await first
    expect(records.get(source.id)?.text).toBe('Pending save')
    expect(records.get(id)?.text).toBe('Pending save')
    expect(records.size).toBe(2)
  })

  it('keeps the local buffer and original database record when capacity prevents a copy', async () => {
    const other = await conflict()
    database.saveDraft.mockRejectedValueOnce(new CreationDraftCapacityError())
    await expect(saveCreationDraftCopy(source.id)).rejects.toThrow('full')
    expect(entry().buffer.text).toBe('My edited text')
    expect(entry().conflict).toBe(true)
    expect(records.get(source.id)).toEqual(other)
    expect(records.size).toBe(1)
    expect(database.deleteDraft).not.toHaveBeenCalled()
  })

  it('keeps newest source text and removes an incomplete copy if catch-up saving fails', async () => {
    const other = await conflict()
    database.saveDraft
      .mockImplementationOnce(async (input, revision) => {
        editCreationDraft({ ...entry().buffer, text: 'Newest unsaved text' })
        return save(input, revision)
      })
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(saveCreationDraftCopy(source.id)).rejects.toThrow('disk unavailable')
    expect(entry().buffer.text).toBe('Newest unsaved text')
    expect(records.get(source.id)).toEqual(other)
    expect(records.size).toBe(1)
  })

  it('bounds catch-up attempts while preserving source edits', async () => {
    await conflict()
    let edits = 0
    database.saveDraft.mockImplementation(async (input, revision) => {
      editCreationDraft({ ...entry().buffer, text: `Concurrent edit ${++edits}` })
      return save(input, revision)
    })
    await expect(saveCreationDraftCopy(source.id)).rejects.toThrow('kept changing')
    expect(edits).toBe(3)
    expect(entry().buffer.text).toBe('Concurrent edit 3')
    expect(records.size).toBe(1)
  })

  it('exposes conflicts discovered by discard without deleting either text', async () => {
    const other = { ...source, text: 'Other window text', revision: 2 }
    records.set(source.id, other)
    await expect(discardCreationDraft(source.id)).rejects.toThrow('another editor')
    expect(entry().conflict).toBe(true)
    expect(entry().buffer.text).toBe(source.text)
    expect(records.get(source.id)).toEqual(other)
  })
})
