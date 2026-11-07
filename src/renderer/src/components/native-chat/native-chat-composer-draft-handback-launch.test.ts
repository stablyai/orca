// @vitest-environment happy-dom
// The draft's current-base writer under the real host-launch loop: a late load and a stale writer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred
} from '../../lib/structured-agent-session-launch-create-message.test-fixture'
import { retryStructuredAgentSessionLaunch } from '../../lib/agent-session/launch/structured-agent-session-launch'
import { resetStructuredAgentLaunchRegistryForTests } from '../../lib/agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '../../lib/agent-session/launch/structured-agent-session-launch-persistence'
import { forgetStructuredSessionSelection } from '../../lib/structured-agent-session-selection-controller'
import type { AgentLaunchReleasePhaseStatusResult } from '../../../../shared/rpc-contract/agent-launch-accept-params'
import {
  AWAITING,
  HELD,
  MESSAGE_ID,
  OPERATION_ID,
  SAVED,
  SESSION_ID,
  SOURCE_SCOPE,
  coldReload,
  host,
  hostAnswers,
  lifecycle,
  refuseDraftWrites,
  seedCatalog,
  startReleaseLaunch
} from '../../lib/agent-session/launch/structured-agent-session-host-launch.test-fixture'
import * as store from './native-chat-composer-draft-store'
import * as storageModule from './native-chat-composer-draft-storage'
import * as handback from './native-chat-composer-draft-handback'

const SCOPE = `agent-session:${SESSION_ID}`
const A = 'Also run lint'
const RECEIPT = { operationId: OPERATION_ID, clientMessageId: MESSAGE_ID }

/** Whether the draft holds the launch's receipt, with or without its session named. */
const heldReceipt = () =>
  handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT) ||
  handback.nativeChatDraftHasReceipt(SCOPE, { ...RECEIPT, sessionId: SESSION_ID })

function savedRow(): Record<string, unknown> | undefined {
  const rows: Record<string, unknown>[] = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
  return rows.find((row) => row.sessionId === SESSION_ID)
}

const text = (scope = SCOPE) => store.readNativeChatComposerDraft(scope).text

/** Prepared and released; the parent's answer is the test's to give. */
async function released() {
  const parent = deferred<AgentLaunchReleasePhaseStatusResult>()
  host.status.mockResolvedValueOnce(AWAITING).mockReturnValue(parent.promise)
  host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  startReleaseLaunch()
  await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
  return parent
}

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  mocks.exactSupport.mockResolvedValue(true)
  host.prepare.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  forgetStructuredSessionSelection(SESSION_ID)
  seedCatalog()
  store.updateNativeChatComposerDraft(SOURCE_SCOPE, { text: '', images: [] }, 'immediate')
})
afterEach(() => {
  refuseDraftWrites(false)
  cleanupCreateMessageFixture(restore)
})

describe('a returned opening and a draft whose saved base the renderer has not read', () => {
  it("keeps the launch's own message when loading gave up and typing, then a return, precede its own held read", async () => {
    const backend = storageModule.nativeChatComposerDraftStorage()
    await store.hydrateNativeChatComposerDrafts()
    const parent = await released()
    parent.resolve({ state: 'running' })
    store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
    await store.nativeChatComposerDraftWritesSettled()
    expect(savedRow()?.firstMessage).toBeTruthy()
    // A cold restart whose every load fails, and whose chat's own read is held.
    store.clearNativeChatComposerDraftsForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    const read = deferred<void>()
    storageModule.setNativeChatComposerDraftStorageForTests({
      ...backend,
      loadAll: () => Promise.reject(new Error('database busy')),
      update: async (scope, apply) => {
        await read.promise
        await backend.update(scope, apply)
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.hydrateNativeChatComposerDrafts()
    await vi.advanceTimersByTimeAsync(36_000)
    expect(text()).toBe('')
    // Before any typing, the launch's saved row alone holds the message it will return, under its
    // own operation and message identity; the conversation's draft holds only its ordinary A.
    expect(savedRow()).toMatchObject({
      hostLaunchOperationId: OPERATION_ID,
      firstMessage: {
        clientMessageId: MESSAGE_ID,
        body: { blocks: [{ type: 'text', text: HELD }] }
      }
    })
    expect(await backend.read(SCOPE)).toMatchObject({ text: A })
    expect(await backend.read(SCOPE)).not.toHaveProperty('handbacks')
    // Ordinary rich typing: text with its editor document, a pasted file and an image.
    const paste = '0b9e7b62-1b0c-4a7a-9c3e-2f6a1d2c3b4a'
    const typed = `typed meanwhile [Pasted text](orca-paste:${paste})`
    const image = { id: 'typed-image', path: '/client/typed.png' }
    const cache = await import('./native-chat-draft-cache')
    cache.writeNativeChatDraftDocument(
      SCOPE,
      typed,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: typed }] }] },
      { [paste]: '/client/paste.txt' }
    )
    store.updateNativeChatComposerDraft(SCOPE, { images: [image] }, 'deferred')
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    // Before its read: the typing shows, the message is owed by the launch and unshown.
    expect(text()).toBe(typed)
    expect(savedRow()?.firstMessage).toBeTruthy()
    expect(await backend.read(SCOPE)).toMatchObject({ text: A })
    read.resolve()
    await store.nativeChatComposerDraftWritesSettled()
    // Ordinary typing replaced the unseen ordinary A; the launch's own message joins it once.
    const once = `${typed}\n\n${HELD}`
    const expected = {
      text: once,
      images: [image],
      pastedTextFiles: { [paste]: '/client/paste.txt' },
      document: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: typed }] },
          { type: 'paragraph' },
          { type: 'paragraph', content: [{ type: 'text', text: HELD }] }
        ]
      }
    }
    expect(store.readNativeChatComposerDraft(SCOPE)).toMatchObject(expected)
    expect(await backend.read(SCOPE)).toMatchObject(expected)
    // Then the launch lets go, only once the draft holds it.
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    await vi.waitFor(() => expect(heldReceipt()).toBe(false))
    await store.nativeChatComposerDraftWritesSettled()
    expect(text()).toBe(once)
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(host.release).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('keeps stored A when the user edits the returned input before the late load lands', async () => {
    const backend = storageModule.nativeChatComposerDraftStorage()
    await store.hydrateNativeChatComposerDrafts()
    const parent = await released()
    parent.resolve({ state: 'running' })
    store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
    await store.nativeChatComposerDraftWritesSettled()
    // The next renderer: its launch row still owes the opening; its draft load is slow.
    store.clearNativeChatComposerDraftsForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    const loaded = deferred<void>()
    storageModule.setNativeChatComposerDraftStorageForTests({
      ...backend,
      loadAll: async () => {
        const result = await backend.loadAll()
        await loaded.promise
        return result
      }
    })
    const loading = store.hydrateNativeChatComposerDrafts()
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    // The scope's own read gave the returned input its complete base, before the load lands.
    await vi.waitFor(() => expect(text()).toBe(`${A}\n\n${HELD}`))
    // Startup stops waiting after 1500ms: the user edits what the composer shows.
    await vi.advanceTimersByTimeAsync(1501)
    store.updateNativeChatComposerDraft(SCOPE, { text: `${text()}\nAnd run tests` }, 'immediate')
    loaded.resolve()
    await loading
    await store.nativeChatComposerDraftWritesSettled()

    const once = `${A}\n\n${HELD}\nAnd run tests`
    expect(text()).toBe(once)
    expect(await backend.read(SCOPE)).toMatchObject({ text: once })
    await coldReload()
    expect(text()).toBe(once)
    expect(host.release).toHaveBeenCalledOnce()
  })

  it('keeps an adopted receipt through another renderer’s stale typing commit', async () => {
    const backend = storageModule.nativeChatComposerDraftStorage()
    await store.hydrateNativeChatComposerDrafts()
    store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
    await store.nativeChatComposerDraftWritesSettled()
    // A second renderer loads this conversation, then types with its normal deferred writer.
    vi.resetModules()
    const secondStorage = await import('./native-chat-composer-draft-storage')
    secondStorage.setNativeChatComposerDraftStorageForTests(backend)
    const second = await import('./native-chat-composer-draft-store')
    await second.hydrateNativeChatComposerDrafts()
    const latest = 'Latest typing from the other window'
    second.updateNativeChatComposerDraft(SCOPE, { text: latest }, 'deferred')
    const parent = await released()
    const realSet = localStorage.setItem.bind(localStorage)
    const quota = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === SAVED) {
        throw new DOMException('full', 'QuotaExceededError')
      }
      realSet(key, value)
    })
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    await store.nativeChatComposerDraftWritesSettled()
    expect(heldReceipt()).toBe(true)
    expect(savedRow()?.firstMessage).toBeTruthy()
    // This renderer restarts; the other one's typing timer then commits and broadcasts.
    await coldReload()
    expect(heldReceipt()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    await second.nativeChatComposerDraftWritesSettled()
    await vi.waitFor(() => expect(text()).toBe(latest))
    expect(heldReceipt()).toBe(true)
    expect(await backend.read(SCOPE)).toMatchObject({
      text: latest,
      handbacks: [expect.objectContaining(RECEIPT)]
    })

    quota.mockRestore()
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    // The source is durably retired, so its receipt goes; the later typing stays, with no new B.
    await vi.waitFor(() => expect(heldReceipt()).toBe(false))
    await store.nativeChatComposerDraftWritesSettled()
    expect(text()).toBe(latest)
    expect(await backend.read(SCOPE)).toEqual(
      expect.not.objectContaining({ handbacks: expect.anything() })
    )
    expect(host.release).toHaveBeenCalledOnce()
    second.clearNativeChatComposerDraftsForTests()
  })

  it.each([
    ['its newer typing', 'Latest typing from the other window plus one keystroke'],
    ['its clear', '']
  ])(
    'keeps stored custody through a stale window’s newer unload snapshot of %s and a slow replay read',
    async (_case, latest) => {
      const backend = storageModule.nativeChatComposerDraftStorage()
      await store.hydrateNativeChatComposerDrafts()
      store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
      await store.nativeChatComposerDraftWritesSettled()
      vi.resetModules()
      const secondStorage = await import('./native-chat-composer-draft-storage')
      secondStorage.setNativeChatComposerDraftStorageForTests(backend)
      const second = await import('./native-chat-composer-draft-store')
      await second.hydrateNativeChatComposerDrafts()
      second.updateNativeChatComposerDraft(
        SCOPE,
        { text: 'Latest typing from the other window' },
        'deferred'
      )
      const parent = await released()
      const realSet = localStorage.setItem.bind(localStorage)
      const quota = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
        if (key === SAVED) {
          throw new DOMException('full', 'QuotaExceededError')
        }
        realSet(key, value)
      })
      parent.resolve({ state: 'unknown' })
      await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      await store.nativeChatComposerDraftWritesSettled()
      expect(heldReceipt()).toBe(true)
      expect(savedRow()?.firstMessage).toBeTruthy()
      expect(await backend.read(SCOPE)).toMatchObject({
        handbacks: [expect.objectContaining(RECEIPT)]
      })
      // That window's database will not open before it unloads; its transaction never starts.
      const opening = deferred<void>()
      secondStorage.setNativeChatComposerDraftStorageForTests({
        ...backend,
        update: async (scope, apply) => {
          await opening.promise
          await backend.update(scope, apply)
        }
      })
      // One more edit in the stale window, still dirty, after the hand-back committed.
      await vi.advanceTimersByTimeAsync(1)
      second.updateNativeChatComposerDraft(SCOPE, { text: latest }, 'deferred')
      window.dispatchEvent(new Event('pagehide'))
      const journal: {
        scopeKey: string
        at: number
        draft?: { text: string; handbacks?: unknown }
      }[] = JSON.parse(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1') ?? '[]')
      // A newer ordinary snapshot that never saw the receipt: the edit, or the clear's removal.
      const snapshot = journal.find(
        (entry) =>
          entry.scopeKey === SCOPE && (latest ? entry.draft?.text === latest : entry.draft === null)
      )
      expect(snapshot).toBeDefined()
      expect(snapshot?.draft?.handbacks).toBeUndefined()
      expect(snapshot!.at).toBeGreaterThan(
        ((await backend.read(SCOPE)) as { savedAt: number }).savedAt
      )
      opening.reject(new Error('renderer terminated before database open'))
      second.clearNativeChatComposerDraftsForTests()
      await Promise.resolve()
      // This renderer restarts; the write that would repair its replayed draft reads slowly.
      const replayRead = deferred<void>()
      storageModule.setNativeChatComposerDraftStorageForTests({
        ...backend,
        update: async (scope, apply) => {
          await replayRead.promise
          await backend.update(scope, apply)
        }
      })
      await coldReload()
      // Already right as published, before any Retry: the newer content (empty after the clear),
      // and the stored receipt it never saw.
      expect(text()).toBe(latest)
      expect(heldReceipt()).toBe(true)
      quota.mockRestore()
      host.status.mockReset()
      host.status.mockResolvedValue({ state: 'unknown' })
      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
      expect(text()).toBe(latest)
      replayRead.resolve()
      await store.nativeChatComposerDraftWritesSettled()
      expect(text()).toBe(latest)
      expect(host.prepare).toHaveBeenCalledOnce()
      expect(host.release).toHaveBeenCalledOnce()
      // The source is retired, so the receipt goes too, with nothing returned; a cleared draft
      // leaves no record at all.
      await vi.waitFor(() => expect(heldReceipt()).toBe(false))
      await store.nativeChatComposerDraftWritesSettled()
      expect(text()).toBe(latest)
      if (latest) {
        expect(await backend.read(SCOPE)).toMatchObject({ text: latest })
      } else {
        expect(await backend.read(SCOPE)).toBeUndefined()
      }
      expect(host.release).toHaveBeenCalledOnce()
    }
  )

  it('lets go of the opening only once the draft holds it, and returns it once through a refused backend and unload', async () => {
    const backend = storageModule.nativeChatComposerDraftStorage()
    await store.hydrateNativeChatComposerDrafts()
    store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
    await store.nativeChatComposerDraftWritesSettled()
    const parent = await released()
    refuseDraftWrites(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    // The draft holds it (its refused write's journal copy carries it), so the source lets go.
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    await vi.waitFor(() => expect(heldReceipt()).toBe(false))
    expect(text()).toBe(`${A}\n\n${HELD}`)
    window.dispatchEvent(new Event('pagehide'))
    refuseDraftWrites(false)
    await coldReload()
    expect(text()).toBe(`${A}\n\n${HELD}`)
    await store.nativeChatComposerDraftWritesSettled()
    expect(await backend.read(SCOPE)).toMatchObject({ text: `${A}\n\n${HELD}` })
    expect(host.release).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('keeps the opening owed and unshown while the draft’s base is unread, then joins it once', async () => {
    const backend = storageModule.nativeChatComposerDraftStorage()
    await store.hydrateNativeChatComposerDrafts()
    const parent = await released()
    parent.resolve({ state: 'running' })
    store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
    await store.nativeChatComposerDraftWritesSettled()
    store.clearNativeChatComposerDraftsForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    const loaded = deferred<void>()
    const read = deferred<void>()
    storageModule.setNativeChatComposerDraftStorageForTests({
      ...backend,
      loadAll: async () => {
        const result = await backend.loadAll()
        await loaded.promise
        return result
      },
      update: async (scope, apply) => {
        await read.promise
        await backend.update(scope, apply)
      }
    })
    const loading = store.hydrateNativeChatComposerDrafts()
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(heldReceipt()).toBe(true))
    // Not shown and not let go: whether it was adopted before is still unknown.
    expect(text()).toBe('')
    expect(handback.nativeChatDraftReceiptProgress(SCOPE, RECEIPT).incorporated).toBe(false)
    expect(savedRow()?.firstMessage).toBeTruthy()
    // The user can still type; ordinary typing replaces the unseen saved draft, and the return
    // joins it once its read shows the return is not already held.
    store.updateNativeChatComposerDraft(SCOPE, { text: 'typed meanwhile' }, 'immediate')
    expect(text()).toBe('typed meanwhile')
    read.resolve()
    const once = `typed meanwhile\n\n${HELD}`
    await vi.waitFor(() => expect(text()).toBe(once))
    loaded.resolve()
    await loading
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    await vi.waitFor(() => expect(heldReceipt()).toBe(false))
    await store.nativeChatComposerDraftWritesSettled()
    expect(text()).toBe(once)
    expect(await backend.read(SCOPE)).toMatchObject({ text: once })
    expect(host.release).toHaveBeenCalledOnce()
  })

  it('lets go of the return once its complete fallback replaces itself within the cap, while the backend still refuses', async () => {
    const A_LARGE = 'a'.repeat(70_000)
    await store.hydrateNativeChatComposerDrafts()
    store.updateNativeChatComposerDraft(SCOPE, { text: A_LARGE, images: [] }, 'immediate')
    await store.nativeChatComposerDraftWritesSettled()
    const parent = await released()
    const journal = 'orca:nativeChatComposerDraftJournal:v1'
    const journaled: string[] = []
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === journal) {
        journaled.push(value)
      }
      setItem(key, value)
    })
    // Only the draft's backend refuses, from here to the end.
    refuseDraftWrites(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    // With no backend recovery and no further edit, the receipt goes once its replacement fits.
    await vi.waitFor(() => expect(heldReceipt()).toBe(false))
    await store.nativeChatComposerDraftWritesSettled()
    const once = `${A_LARGE}\n\n${HELD}`
    expect(text() === once).toBe(true)
    // The receipt-bearing complete fallback and its receipt-free replacement each fit the whole
    // cap; the two together would not.
    const fallback = journaled.find((value) => value.includes('"handbacks"')) ?? ''
    const replacement = localStorage.getItem(journal) ?? ''
    expect(fallback.length).toBeLessThan(256_000)
    expect(replacement.length).toBeLessThan(256_000)
    expect(fallback.length + replacement.length).toBeGreaterThan(256_000)
    const [entry] = JSON.parse(replacement)
    expect(entry.draft.text === once).toBe(true)
    expect(entry.draft).not.toHaveProperty('handbacks')
    // An actual same-O Retry settles with nothing new issued.
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    await store.nativeChatComposerDraftWritesSettled()
    expect(text() === once).toBe(true)
    expect(heldReceipt()).toBe(false)
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(host.release).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
