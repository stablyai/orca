import { beforeEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn()
}))
const delivery = vi.hoisted(() => ({
  captureCreationDraftTarget: vi.fn(),
  sendCreationDraft: vi.fn()
}))
vi.mock('./creation-draft-database', () => database)
vi.mock('./creation-draft-delivery', () => delivery)
import {
  CreationDraftConflictError,
  type CreationDraft,
  type CreationDraftInput
} from './creation-draft-record'
import {
  editCreationDraft,
  flushCreationDraft,
  useCreationDraftSession
} from './creation-draft-session'
import { submitCreationDraft } from './creation-draft-submit'

const source: CreationDraftInput = {
  id: 'draft',
  title: 'Workspace',
  text: 'Keep this source',
  agent: 'codex',
  executionHostId: 'local',
  updatedAt: 1,
  target: { worktreeId: 'workspace', terminalHandle: 'original', incarnationId: 'incarnation' }
}
let durable: CreationDraft | null
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function save(input: CreationDraftInput, expected: number | null): Promise<CreationDraft> {
  if ((durable?.revision ?? null) !== expected) {
    throw new CreationDraftConflictError(durable)
  }
  durable = { ...input, revision: (expected ?? 0) + 1 }
  return durable
}
const current = () => useCreationDraftSession.getState().entries[source.id]

beforeEach(async () => {
  vi.resetAllMocks()
  durable = null
  useCreationDraftSession.setState({
    entries: {},
    loaded: true,
    loadError: null,
    viewedDraftId: null
  })
  database.saveDraft.mockImplementation(save)
  delivery.sendCreationDraft.mockResolvedValue({ status: 'delivered' })
  editCreationDraft(source)
  await flushCreationDraft(source.id)
})

describe('creation draft explicit delivery', () => {
  it('waits for the sending attempt to commit before invoking the sender', async () => {
    const gate = deferred<void>()
    database.saveDraft.mockImplementationOnce(async (input, revision) => {
      await gate.promise
      return save(input, revision)
    })
    const submitting = submitCreationDraft(source.id)
    await vi.waitFor(() => expect(database.saveDraft).toHaveBeenCalledTimes(2))
    expect(durable?.delivery).toBeUndefined()
    expect(delivery.sendCreationDraft).not.toHaveBeenCalled()
    gate.resolve()
    expect(await submitting).toEqual({ status: 'delivered' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledExactlyOnceWith({
      target: { executionHostId: 'local', ...source.target },
      text: source.text
    })
    expect(durable).toMatchObject({
      text: source.text,
      delivery: { state: 'delivered', revision: 1 }
    })
  })

  it('allows a deliberate retry after attempt persistence fails without sending any bytes', async () => {
    database.saveDraft.mockRejectedValueOnce(new Error('disk unavailable'))
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'not-saved' })
    expect(delivery.sendCreationDraft).not.toHaveBeenCalled()
    expect(current().buffer).toMatchObject({ text: source.text })
    expect(current().buffer.delivery).toBeUndefined()
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'delivered' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledOnce()
  })

  it('deduplicates simultaneous Send actions for one draft', async () => {
    const sending = deferred<{ status: 'delivered' }>()
    delivery.sendCreationDraft.mockReturnValue(sending.promise)
    const first = submitCreationDraft(source.id)
    const second = submitCreationDraft(source.id)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(delivery.sendCreationDraft).toHaveBeenCalledOnce())
    sending.resolve({ status: 'delivered' })
    await Promise.all([first, second])
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'already-attempted' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledOnce()
  })

  it('keeps uncertain delivery and source without replaying after a transport error', async () => {
    delivery.sendCreationDraft.mockRejectedValue(new Error('connection lost after write'))
    expect(await submitCreationDraft(source.id)).toEqual({
      status: 'uncertain',
      reason: 'transport'
    })
    expect(durable).toMatchObject({ text: source.text, delivery: { state: 'uncertain' } })
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'already-attempted' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledOnce()
  })

  it('leaves remount edits unsent when an older version finishes sending', async () => {
    const sending = deferred<{ status: 'delivered' }>()
    delivery.sendCreationDraft.mockReturnValue(sending.promise)
    const submitting = submitCreationDraft(source.id)
    await vi.waitFor(() => expect(delivery.sendCreationDraft).toHaveBeenCalledOnce())
    editCreationDraft({ ...current().buffer, text: 'Newer source' })
    sending.resolve({ status: 'delivered' })
    await submitting
    expect(durable).toMatchObject({ text: 'Newer source' })
    expect(durable?.delivery).toBeUndefined()
    expect(delivery.sendCreationDraft).toHaveBeenCalledOnce()
    expect(delivery.sendCreationDraft.mock.calls[0][0].text).toBe(source.text)
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'delivered' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledTimes(2)
    expect(delivery.sendCreationDraft.mock.calls[1][0].text).toBe('Newer source')
    expect(durable?.delivery?.state).toBe('delivered')
  })

  it('retains the uncertain fence when text changes during an unconfirmed send', async () => {
    const sending = deferred<{ status: 'uncertain'; reason: 'transport' }>()
    delivery.sendCreationDraft.mockReturnValue(sending.promise)
    const submitting = submitCreationDraft(source.id)
    await vi.waitFor(() => expect(delivery.sendCreationDraft).toHaveBeenCalledOnce())
    editCreationDraft({ ...current().buffer, text: 'Newer source' })
    sending.resolve({ status: 'uncertain', reason: 'transport' })
    await submitting
    expect(durable).toMatchObject({ text: 'Newer source', delivery: { state: 'uncertain' } })
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'already-attempted' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledOnce()
  })

  it.each(['sending', 'uncertain'] as const)(
    'keeps a restored %s fence after editing without replaying the attempt',
    async (state) => {
      editCreationDraft({
        ...source,
        delivery: { attemptId: 'previous-renderer', revision: 1, state }
      })
      await flushCreationDraft(source.id)
      const { revision, ...buffer } = durable!
      useCreationDraftSession.setState({
        entries: {
          [source.id]: {
            buffer,
            storedRevision: revision,
            editVersion: 0,
            savedVersion: 0,
            error: null
          }
        }
      })
      editCreationDraft({ ...current().buffer, text: 'Edited recovered source' })
      expect(await submitCreationDraft(source.id)).toEqual({ status: 'already-attempted' })
      expect(delivery.sendCreationDraft).not.toHaveBeenCalled()
      expect(durable).toMatchObject({ text: 'Edited recovered source', delivery: { state } })
    }
  )

  it('refuses sending when another window has already committed a delivery attempt', async () => {
    durable = {
      ...durable!,
      revision: 2,
      delivery: { attemptId: 'other-window', revision: 1, state: 'sending' }
    }
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'not-saved' })
    expect(delivery.sendCreationDraft).not.toHaveBeenCalled()
    expect(durable.delivery).toMatchObject({ attemptId: 'other-window', state: 'sending' })
    expect(current().buffer.text).toBe(source.text)
  })

  it('requires a new Send when text changes during target resolution', async () => {
    editCreationDraft({
      ...source,
      target: { worktreeId: 'workspace', terminalHandle: 'original' }
    })
    await flushCreationDraft(source.id)
    const capture = deferred<{ terminalHandle: string; incarnationId: string }>()
    delivery.captureCreationDraftTarget.mockReturnValue(capture.promise)
    const submitting = submitCreationDraft(source.id)
    await vi.waitFor(() => expect(delivery.captureCreationDraftTarget).toHaveBeenCalledOnce())
    editCreationDraft({ ...current().buffer, text: 'Edited during resolution' })
    capture.resolve({ terminalHandle: 'original', incarnationId: 'incarnation' })
    expect(await submitting).toEqual({ status: 'not-saved' })
    await flushCreationDraft(source.id)
    expect(delivery.sendCreationDraft).not.toHaveBeenCalled()
    expect(durable?.text).toBe('Edited during resolution')
  })

  it('keeps the durable sending fence if recording the outcome fails', async () => {
    delivery.sendCreationDraft.mockImplementation(async () => {
      database.saveDraft.mockRejectedValue(new Error('disk unavailable'))
      return { status: 'delivered' }
    })
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'delivered' })
    expect(durable).toMatchObject({ text: source.text, delivery: { state: 'sending' } })
    database.saveDraft.mockImplementation(save)
    expect(await submitCreationDraft(source.id)).toEqual({ status: 'already-attempted' })
    expect(delivery.sendCreationDraft).toHaveBeenCalledOnce()
    expect(durable).toMatchObject({ text: source.text, delivery: { state: 'delivered' } })
  })
})
