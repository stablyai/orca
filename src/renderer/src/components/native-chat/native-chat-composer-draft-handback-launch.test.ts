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
})
