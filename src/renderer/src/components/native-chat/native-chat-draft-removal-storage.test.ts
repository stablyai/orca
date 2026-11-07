// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createIndexedDbNativeChatComposerDraftStorage } from './native-chat-composer-draft-indexeddb'
import { nativeChatDraftTestDatabase } from './native-chat-draft-test-database'
import {
  setNativeChatComposerDraftStorageForTests,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'
import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { JOURNAL_KEY } from './native-chat-composer-draft-journal'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  settleNativeChatPendingAttachmentReferences
} from './native-chat-pending-attachment-cache'
import { createChatDraftRemovalReceipt } from '@/store/slices/worktrees/teardown/chat-draft-removal-receipt'

const { locate } = vi.hoisted(() => ({ locate: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: locate
}))
const SESSION = 'draft-storage-37190'
const SCOPE = `agent-session:${SESSION}`
const WORKSPACE = 'project-37190::/project'
const draft = {
  text: 'captured unsent',
  images: [],
  savedAt: 7,
  owner: { workspaceId: WORKSPACE, executionHostId: 'local' as const }
}
let storage: NativeChatComposerDraftStorage
const location = { location: { kind: 'chat', sessionId: SESSION, worktreeId: WORKSPACE } }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
function remove() {
  const receipt = createChatDraftRemovalReceipt(() => ({ unifiedTabsByWorktree: {} }))
  receipt.capture({ executionHostId: 'local' })({ projectId: 'project-37190' })
  return receipt.finish()
}
async function reload() {
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  await nativeChatComposerDraftWritesSettled()
}
beforeEach(async () => {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  localStorage.clear()
  storage = createIndexedDbNativeChatComposerDraftStorage(nativeChatDraftTestDatabase())
  setNativeChatComposerDraftStorageForTests(storage)
  locate.mockResolvedValue(location)
  await storage.write(SCOPE, draft)
})
afterEach(() => {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('clears the selected durable value and journal without resurrecting it after reload', async () => {
  localStorage.setItem(
    JOURNAL_KEY,
    JSON.stringify([{ scopeKey: SCOPE, draft, at: 7, run: 'old-run' }])
  )
  await hydrateNativeChatComposerDrafts()
  await remove()
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
  expect(await storage.read(SCOPE)).toBeUndefined()
})

it('retains a different same-time foreign value and a later journal entry during cleanup', async () => {
  await hydrateNativeChatComposerDrafts()
  const captured = { scopeKey: SCOPE, draft, at: 7, run: 'old-run' }
  const opaque = { futureEntry: ['keep', 37190] }
  const replacement = { ...draft, text: 'later foreign content' }
  const later = { scopeKey: SCOPE, draft: replacement, at: 7, run: 'foreign-run' }
  localStorage.setItem(JOURNAL_KEY, JSON.stringify([captured, opaque]))
  locate.mockImplementation(async () => {
    await storage.write(SCOPE, replacement)
    localStorage.setItem(JOURNAL_KEY, JSON.stringify([captured, opaque, later]))
    return location
  })
  await remove()
  expect(await storage.read(SCOPE)).toEqual(replacement)
  expect(JSON.parse(localStorage.getItem(JOURNAL_KEY)!)).toEqual([opaque, later])
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('later foreign content')
})

it('an initial snapshot and selected append cannot restore content after its removal', async () => {
  const initial = deferred<ReadonlyMap<string, unknown>>()
  const started = deferred<void>()
  vi.spyOn(storage, 'loadAll').mockImplementationOnce(async () => {
    const snapshot = new Map([[SCOPE, draft]])
    started.resolve()
    return initial.promise.then(() => snapshot)
  })
  const loading = hydrateNativeChatComposerDrafts()
  await started.promise
  appendToNativeChatComposerDraft(SCOPE, { text: 'selected returned text' })
  await nativeChatComposerDraftWritesSettled()
  await remove()
  initial.resolve(new Map())
  await loading
  await nativeChatComposerDraftWritesSettled()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
  expect(await storage.read(SCOPE)).toBeUndefined()
})

it('clears captured journal additions materialized while the location request is pending', async () => {
  const initial = deferred<ReadonlyMap<string, unknown>>()
  const started = deferred<void>()
  const locating = deferred<void>()
  const reply = deferred<typeof location>()
  localStorage.setItem(
    JOURNAL_KEY,
    JSON.stringify([
      {
        scopeKey: SCOPE,
        at: 8,
        run: 'older-run',
        addition: { images: [{ id: 'journal-image', path: '/captured.png' }] }
      }
    ])
  )
  vi.spyOn(storage, 'loadAll').mockImplementationOnce(async () => {
    started.resolve()
    return initial.promise
  })
  const loading = hydrateNativeChatComposerDrafts()
  await started.promise
  locate.mockImplementation(() => {
    locating.resolve()
    return reply.promise
  })
  const removing = remove()
  await locating.promise
  initial.resolve(new Map([[SCOPE, draft]]))
  await loading
  await nativeChatComposerDraftWritesSettled()
  expect(readNativeChatComposerDraft(SCOPE)).toMatchObject({
    text: 'captured unsent',
    images: [{ id: 'journal-image', path: '/captured.png' }]
  })
  reply.resolve(location)
  await removing
  expect(readNativeChatComposerDraft(SCOPE)).toMatchObject({ text: '', images: [] })
  await reload()
  expect(readNativeChatComposerDraft(SCOPE)).toMatchObject({ text: '', images: [] })
})

it('a stale foreign read cannot restore selected content or erase a later saved edit', async () => {
  const channels: { onmessage: ((event: { data: unknown }) => void) | null }[] = []
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage = null
      constructor() {
        channels.push(this)
      }
      close() {}
      postMessage() {}
    }
  )
  await hydrateNativeChatComposerDrafts()
  const read = deferred<unknown>()
  const started = deferred<void>()
  vi.spyOn(storage, 'read').mockImplementationOnce(() => {
    started.resolve()
    return read.promise
  })
  channels[0]!.onmessage?.({ data: { scopeKey: SCOPE } })
  await started.promise
  await remove()
  updateNativeChatComposerDraft(SCOPE, { text: 'new input', owner: draft.owner }, 'immediate')
  await nativeChatComposerDraftWritesSettled()
  read.resolve(draft)
  await read.promise
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('new input')
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('new input')
})

it('a load begun during membership lookup clears captured content and leaves subsequent input usable', async () => {
  const locating = deferred<void>()
  const reply = deferred<typeof location>()
  locate.mockImplementation(() => {
    locating.resolve()
    return reply.promise
  })
  const removing = remove()
  await locating.promise
  // This is a fresh load lifetime; none was active at the receipt's census.
  await hydrateNativeChatComposerDrafts()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('captured unsent')
  reply.resolve(location)
  await removing
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
  updateNativeChatComposerDraft(
    SCOPE,
    { text: 'subsequent independent input', owner: draft.owner },
    'immediate'
  )
  await nativeChatComposerDraftWritesSettled()
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('subsequent independent input')
})

it('a new pending load cannot restore selected content when positive cleanup finishes first', async () => {
  const locating = deferred<void>()
  const reply = deferred<typeof location>()
  locate.mockImplementation(() => {
    locating.resolve()
    return reply.promise
  })
  const removing = remove()
  await locating.promise
  const loaded = deferred<ReadonlyMap<string, unknown>>()
  vi.spyOn(storage, 'loadAll').mockImplementationOnce(() => loaded.promise)
  const loading = hydrateNativeChatComposerDrafts()
  reply.resolve(location)
  await removing
  loaded.resolve(new Map([[SCOPE, draft]]))
  await loading
  await nativeChatComposerDraftWritesSettled()
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
})

it('a production retry begun during membership lookup cannot retain its captured saved draft', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(storage, 'loadAll').mockRejectedValueOnce(new Error('transient database failure'))
  await hydrateNativeChatComposerDrafts()
  const locating = deferred<void>()
  const reply = deferred<typeof location>()
  locate.mockImplementation(() => {
    locating.resolve()
    return reply.promise
  })
  const removing = remove()
  await locating.promise
  await vi.advanceTimersByTimeAsync(1000)
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('captured unsent')
  reply.resolve(location)
  await removing
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
  vi.useRealTimers()
  await reload()
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
})

it.each([false, true])(
  'a retry after captured PDF completion clears only the captured base (foreign replacement: %s)',
  async (foreign) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(storage, 'loadAll').mockRejectedValueOnce(new Error('transient database failure'))
    await hydrateNativeChatComposerDrafts()
    addNativeChatPendingAttachment(SCOPE, { id: 'captured-pdf', path: '', pending: true })
    const locating = deferred<void>()
    const reply = deferred<typeof location>()
    locate.mockImplementation(() => {
      locating.resolve()
      return reply.promise
    })
    const removing = remove()
    await locating.promise
    if (foreign) {
      await storage.write(SCOPE, { ...draft, text: 'independent foreign input' })
    }
    expect(
      settleNativeChatPendingAttachmentReferences(SCOPE, [
        { id: 'captured-pdf', path: '/report.pdf' }
      ])
    ).toBe(true)
    await nativeChatComposerDraftWritesSettled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(readNativeChatComposerDraft(SCOPE).text).toBe(
      foreign ? 'independent foreign input @/report.pdf' : 'captured unsent @/report.pdf'
    )
    reply.resolve(location)
    await removing
    const expected = foreign ? 'independent foreign input @/report.pdf' : ''
    expect(readNativeChatComposerDraft(SCOPE).text).toBe(expected)
    expect(await storage.read(SCOPE)).toEqual(
      foreign ? expect.objectContaining({ text: expected }) : undefined
    )
    vi.useRealTimers()
    await reload()
    expect(readNativeChatComposerDraft(SCOPE).text).toBe(expected)
  }
)
