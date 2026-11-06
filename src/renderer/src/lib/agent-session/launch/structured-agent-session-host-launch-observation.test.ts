// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  draft
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import type { AgentLaunchReleasePhaseStatusResult } from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import { forgetStructuredSessionSelection } from '../../structured-agent-session-selection-controller'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import { resumeHostLaunchPreparation } from './structured-agent-session-host-launch-release'
import { currentHostLaunchObserver } from './structured-agent-session-host-launch-observer'
import { PromiseSettlementWaiters } from '../../../../../shared/promise-settlement-waiters'
import type * as ReceiptEvents from '@/components/native-chat/native-chat-composer-draft-receipt-events'
import { nativeChatComposerDraftStorage } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  editableHostLaunchOpening,
  replaceHeldHostLaunchOpening
} from './structured-agent-session-host-launch-opening-edit'
import { cancelStructuredAgentLaunch } from './structured-agent-session-launch'
import {
  AWAITING,
  CHAT_STARTED,
  IMAGE,
  MESSAGE_ID,
  OPERATION_ID,
  SAVED,
  SESSION_ID,
  SKILLS,
  SOURCE_SCOPE,
  host,
  hostAnswers,
  hostHistory,
  lifecycle,
  savedFirstTurn,
  seedCatalog,
  startRichReleaseLaunch,
  windowCalls,
  refuseDraftWrites,
  coldReload,
  startReleaseLaunch,
  HELD,
  type HostLaunchPrepare
} from './structured-agent-session-host-launch.test-fixture'

type Body = StructuredAgentSessionFirstMessage['body']
type Prepare = HostLaunchPrepare

// Removable receipt-commit subscribers the custody layer holds, counted where they are added.
const receiptListeners = vi.hoisted(() => ({ live: 0 }))
vi.mock('@/components/native-chat/native-chat-composer-draft-receipt-events', async (original) => {
  const actual = await original<typeof ReceiptEvents>()
  return {
    ...actual,
    addNativeChatDraftReceiptListener: (
      ...args: Parameters<typeof actual.addNativeChatDraftReceiptListener>
    ) => {
      receiptListeners.live += 1
      const stop = actual.addNativeChatDraftReceiptListener(...args)
      let stopped = false
      return () => {
        if (!stopped) {
          stopped = true
          receiptListeners.live -= 1
        }
        stop()
      }
    }
  }
})

const TEXT = 'fix this $audit'
const ON_HOST = structuredAgentSessionSendBody(
  TEXT,
  [{ path: '/host/store/upload-1/shot.png', previewUri: '' }],
  SKILLS
)
const lost = () => new Error('runtime_unavailable')

function savedRow(): Record<string, unknown> | undefined {
  const rows: Record<string, unknown>[] = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
  return rows.find((row) => row.sessionId === SESSION_ID)
}

function reload(): void {
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  restorePersistedStructuredLaunchState('workspace-1', SESSION_ID)
}

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  mocks.exactSupport.mockResolvedValue(true)
  host.prepare.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  forgetStructuredSessionSelection(SESSION_ID)
  seedCatalog()
  updateNativeChatComposerDraft(SOURCE_SCOPE, { text: 'Also run lint', images: [] }, 'immediate')
})
afterEach(() => {
  refuseDraftWrites(false)
  cleanupCreateMessageFixture(restore)
})

describe('a prepared launch whose reads go unanswered', () => {
  it.each([
    ['before its first turn was captured', 'editing'],
    ['after its first turn was sent', 'submitted']
  ] as const)(
    'keeps its whole input %s, and Retry continues the same launch',
    async (_case, phase) => {
      const prepare = vi.fn<Prepare>().mockResolvedValue(ON_HOST)
      if (phase === 'editing') {
        // Prepared, then every read fails: three backoffs, then a fourth failure reads unknown.
        host.status.mockRejectedValue(lost())
      } else {
        host.status.mockResolvedValue(AWAITING)
        host.release.mockRejectedValue(lost())
      }
      startRichReleaseLaunch(TEXT, prepare)
      await vi.advanceTimersByTimeAsync(2_500)
      await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      expect(phase === 'editing' ? host.status : host.release).toHaveBeenCalledTimes(4)
      const sent = host.release.mock.calls[0]?.[0]
      // Nothing went back to the composer: the live launch may still take this exact input.
      expect(draft(SESSION_ID)).not.toContain('fix this')
      expect(getStructuredLaunchStateBySessionId(SESSION_ID)?.intent.opening?.clientMessageId).toBe(
        MESSAGE_ID
      )
      expect(savedRow()).toMatchObject({
        lifecycle: 'visibility-unknown',
        firstMessage: { clientMessageId: MESSAGE_ID },
        hostLaunchFirstTurn: { phase }
      })
      // A pick made now still belongs to an unsent first turn, and never to a sent one.
      void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
      // Held across a reload as well.
      reload()
      void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')

      host.status.mockReset()
      host.release.mockReset()
      host.status.mockResolvedValueOnce(AWAITING).mockResolvedValue(CHAT_STARTED)
      host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
      mocks.call.mockResolvedValue(hostHistory())
      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)

      await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
      const released = host.release.mock.calls[0]![0]
      if (phase === 'submitted') {
        expect(released).toEqual(sent)
      } else {
        expect(released).toMatchObject({
          operationId: OPERATION_ID,
          selection: expect.objectContaining({ effort: 'high' }),
          firstMessage: { clientMessageId: MESSAGE_ID }
        })
      }
      await vi.waitFor(() => expect(lifecycle()).toBeNull())
      expect(host.prepare).toHaveBeenCalledOnce()
      expect(windowCalls()).not.toContain('agentSession.create')
      expect(windowCalls()).not.toContain('agentSession.send')
      expect(draft(SESSION_ID)).not.toContain('fix this')
    }
  )

  it.each([
    ['cannot say what became of it', { state: 'unknown' }],
    ['no longer has it', { state: 'absent' }]
  ] as const)(
    'gives the whole input back, and starts nothing, when the host %s after taking it',
    async (_case, answer) => {
      host.status.mockResolvedValueOnce(AWAITING).mockResolvedValue(answer)
      host.release.mockRejectedValue(lost())
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      startRichReleaseLaunch(TEXT, vi.fn<Prepare>().mockResolvedValue(ON_HOST))
      await vi.waitFor(() => expect(host.release).toHaveBeenCalled())
      // Nothing can be saved for now: the input stays the launch's, saved as it last could be.
      const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
      refuseDraftWrites(true)
      await vi.advanceTimersByTimeAsync(2_500)
      await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      full.mockRestore()
      refuseDraftWrites(false)
      expect(getStructuredLaunchStateBySessionId(SESSION_ID)?.intent.opening?.clientMessageId).toBe(
        MESSAGE_ID
      )
      expect(savedRow()).toMatchObject({ firstMessage: { clientMessageId: MESSAGE_ID } })
      const released = host.release.mock.calls.length

      // Read again after a reload: the same answer gives the whole input back, durably, once.
      reload()
      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
      expect(draft(SESSION_ID).match(/fix this \$audit/g)).toHaveLength(1)
      expect(draft(SESSION_ID)).toContain('Also run lint')
      // Whether anything ran is still not known: the chat says so, and nothing starts again.
      expect(lifecycle()).toBe('visibility-unknown')
      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      expect(draft(SESSION_ID).match(/fix this \$audit/g)).toHaveLength(1)
      expect(host.release).toHaveBeenCalledTimes(released)
      expect(host.prepare).toHaveBeenCalledOnce()
      expect(host.accept).not.toHaveBeenCalled()
      expect(windowCalls()).not.toContain('agentSession.create')
      expect(windowCalls()).not.toContain('agentSession.send')
      warn.mockRestore()
    }
  )

  it('reads the launch before giving anything back when its release is refused', async () => {
    host.status
      .mockResolvedValueOnce(AWAITING)
      .mockResolvedValueOnce({ state: 'running' })
      .mockResolvedValue({ state: 'failed', code: 'agent_launch_tab_closed' })
    host.release.mockRejectedValue(
      Object.assign(new Error('refused'), { code: 'agent_session_operation_invalid' })
    )
    startRichReleaseLaunch(TEXT, vi.fn<Prepare>().mockResolvedValue(ON_HOST))
    // Still running after the refusal: unknown, nothing handed back.
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    expect(draft(SESSION_ID)).not.toContain('fix this')
    // The launch's own end is what gives it back.
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
    expect(draft(SESSION_ID)).toContain('fix this')
    expect(draft(SESSION_ID)).toContain('Also run lint')
    expect(windowCalls()).not.toContain('agentSession.send')
  })
})

describe('editing a held opening whose file could not reach the host', () => {
  // While parked, the launch's one read: it answers only once the launch ends.
  let parkedRead: ReturnType<typeof deferred<AgentLaunchReleasePhaseStatusResult>>

  async function parked(prepare: Prepare) {
    parkedRead = deferred<AgentLaunchReleasePhaseStatusResult>()
    host.status.mockResolvedValueOnce(AWAITING).mockReturnValue(parkedRead.promise)
    const launch = startRichReleaseLaunch(TEXT, prepare)
    await vi.waitFor(() =>
      expect(editableHostLaunchOpening('workspace-1', SESSION_ID)).toBeDefined()
    )
    return launch
  }

  it('releases the edited input under the same launch and message, automatically', async () => {
    const launch = await parked(vi.fn<Prepare>().mockRejectedValue(new Error('File not found')))
    expect(editableHostLaunchOpening('workspace-1', SESSION_ID)).toMatchObject({
      opening: { clientMessageId: MESSAGE_ID },
      staged: [IMAGE.path]
    })
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    mocks.call.mockResolvedValue(hostHistory())
    // The image removed; text and skill kept.
    const edited = structuredAgentSessionSendBody(TEXT, [], SKILLS)
    expect(replaceHeldHostLaunchOpening('workspace-1', SESSION_ID, { body: edited })).toBe(true)
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    parkedRead.resolve(CHAT_STARTED)

    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
    expect(host.release).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ firstMessage: { clientMessageId: MESSAGE_ID, body: edited } })
    )
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(draft(SESSION_ID)).toBe('Also run lint')
  })

  it('never releases a preparation the edit replaced, nor one a Close ended', async () => {
    const stale = deferred<Body>()
    const prepare = vi
      .fn<Prepare>()
      .mockRejectedValueOnce(new Error('File not found'))
      .mockReturnValue(stale.promise)
    const launch = await parked(prepare)
    expect(resumeHostLaunchPreparation('workspace-1', SESSION_ID)).toBe(true)
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    const fresh = structuredAgentSessionSendBody('fix this instead', [], SKILLS)
    const replacement = deferred<Body>()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    // Edited while the old file is still on its way: only the edit is ever released.
    replaceHeldHostLaunchOpening('workspace-1', SESSION_ID, {
      body: fresh,
      staged: {
        paths: ['/client/other.png'],
        sources: { prepare: () => replacement.promise, release: () => {} }
      }
    })
    expect(savedFirstTurn()).toMatchObject({ phase: 'editing', staged: ['/client/other.png'] })
    stale.resolve(ON_HOST)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.release).not.toHaveBeenCalled()
    replacement.resolve(fresh)
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    expect(host.release.mock.calls[0]![0]).toMatchObject({
      firstMessage: { clientMessageId: MESSAGE_ID, body: fresh }
    })
    // A submitted turn is the exact input sent: it takes no edit.
    expect(editableHostLaunchOpening('workspace-1', SESSION_ID)).toBeUndefined()
    expect(replaceHeldHostLaunchOpening('workspace-1', SESSION_ID, { body: ON_HOST })).toBe(false)
    expect(savedRow()).toMatchObject({ firstMessage: { body: fresh } })

    // Closed while another preparation is on its way: nothing is released for it.
    cancelStructuredAgentLaunch('workspace-1', SESSION_ID)
    await launch.launchResult.catch(() => undefined)
    expect(host.release).toHaveBeenCalledOnce()
  })
})

describe('a parked launch’s observer', () => {
  /** Every status read stays open until the test answers it. */
  function heldReads() {
    const reads: ReturnType<typeof deferred<AgentLaunchReleasePhaseStatusResult>>[] = []
    host.status.mockImplementation(() => {
      const read = deferred<AgentLaunchReleasePhaseStatusResult>()
      reads.push(read)
      return read.promise
    })
    return reads
  }

  /** Reactions attached to the Retry promise each parked preparation waits on. */
  function countRetryReactions() {
    const counts: number[] = []
    const withResolvers = Promise.withResolvers.bind(Promise)
    const spy = vi.spyOn(Promise, 'withResolvers').mockImplementation(<T>() => {
      const made = withResolvers<T>()
      const caller = new Error('who made this promise').stack
      if (caller?.includes('structured-agent-session-host-launch-release')) {
        const index = counts.push(0) - 1
        vi.spyOn(made.promise, 'then').mockImplementation(function (this: Promise<T>, ...args) {
          counts[index]!++
          return Promise.prototype.then.apply(this, args)
        })
      }
      return made
    })
    return { counts, spy }
  }

  it.each([3, 30])(
    'keeps one reaction and one read across %i status replies and failed Retries',
    async (count) => {
      const reads = heldReads()
      const { counts, spy } = countRetryReactions()
      const prepare = vi.fn<Prepare>().mockRejectedValue(new Error('File not found'))
      try {
        const launch = startRichReleaseLaunch(TEXT, prepare)
        await vi.waitFor(() => expect(reads).toHaveLength(1))
        reads[0]!.resolve(AWAITING)
        await vi.waitFor(() => expect(reads).toHaveLength(2))
        // The host answers each parked read; the Retry promise gains no reaction per answer.
        for (let index = 0; index < count; index++) {
          reads.at(-1)!.resolve({ state: 'running' })
          await vi.waitFor(() => expect(reads).toHaveLength(index + 3))
        }
        // Measured on the Retry promises the parked preparation actually made.
        expect(counts.length).toBeGreaterThan(0)
        expect(Math.max(...counts)).toBe(1)
        // Each Retry fails again while the last read is still open: that read is waited on again.
        for (let index = 0; index < count; index++) {
          expect(resumeHostLaunchPreparation('workspace-1', SESSION_ID)).toBe(true)
          await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(index + 2))
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(reads).toHaveLength(count + 2)
        expect(Math.max(...counts)).toBe(1)
        // A valid file after all that: the same launch takes it once.
        prepare.mockResolvedValue(ON_HOST)
        host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
        mocks.call.mockResolvedValue(hostHistory())
        expect(resumeHostLaunchPreparation('workspace-1', SESSION_ID)).toBe(true)
        await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
        reads.at(-1)!.resolve({ state: 'running' })
        await vi.waitFor(() => expect(reads).toHaveLength(count + 3))
        reads.at(-1)!.resolve(CHAT_STARTED)
        await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
        expect(host.prepare).toHaveBeenCalledOnce()
      } finally {
        spy.mockRestore()
      }
    }
  )

  it.each([3, 30])(
    'detaches every wait it owns when the chat is closed after %i failed Retries',
    async (count) => {
      const reads = heldReads()
      const owners = new Set<PromiseSettlementWaiters<unknown>>()
      const wait = PromiseSettlementWaiters.prototype.wait
      const spy = vi.spyOn(PromiseSettlementWaiters.prototype, 'wait').mockImplementation(function (
        this: PromiseSettlementWaiters<unknown>,
        ...args
      ) {
        owners.add(this)
        return wait.apply(this, args)
      })
      const prepare = vi.fn<Prepare>().mockRejectedValue(new Error('File not found'))
      try {
        const launch = startRichReleaseLaunch(TEXT, prepare)
        await vi.waitFor(() => expect(reads).toHaveLength(1))
        reads[0]!.resolve(AWAITING)
        await vi.waitFor(() => expect(reads).toHaveLength(2))
        for (let index = 0; index < count; index++) {
          expect(resumeHostLaunchPreparation('workspace-1', SESSION_ID)).toBe(true)
          await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(index + 2))
        }
        await vi.advanceTimersByTimeAsync(0)
        const waiting = () => [...owners].reduce((sum, owner) => sum + owner.waiterCount, 0)
        expect(waiting()).toBeGreaterThan(0)
        expect(currentHostLaunchObserver(SESSION_ID)?.resume).toBeDefined()

        // Closed while its one status read is still on its way.
        cancelStructuredAgentLaunch('workspace-1', SESSION_ID)
        await vi.advanceTimersByTimeAsync(0)
        expect(waiting()).toBe(0)
        expect(currentHostLaunchObserver(SESSION_ID)).toBeUndefined()
        expect(resumeHostLaunchPreparation('workspace-1', SESSION_ID)).toBe(false)
        expect(reads).toHaveLength(2)

        // That read answers later: nothing is released, waited on or brought back.
        reads[1]!.resolve(AWAITING)
        await launch.launchResult.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(0)
        expect(reads).toHaveLength(2)
        expect(waiting()).toBe(0)
        expect(host.release).not.toHaveBeenCalled()
        expect(savedRow()).toBeUndefined()
        expect(getStructuredLaunchStateBySessionId(SESSION_ID)).toBeUndefined()
      } finally {
        spy.mockRestore()
      }
    }
  )
})

describe('a plain opening given back to the composer', () => {
  const DRAFT = `agent-session:${SESSION_ID}`
  const full = () =>
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })

  /** Released, then the host can no longer say: the opening comes back to the composer. */
  async function endedAfterRelease(independent = 'Also run lint') {
    updateNativeChatComposerDraft(SOURCE_SCOPE, { text: independent, images: [] }, 'immediate')
    const parent = deferred<AgentLaunchReleasePhaseStatusResult>()
    host.status.mockResolvedValueOnce(AWAITING).mockReturnValue(parent.promise)
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    startReleaseLaunch()
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    return parent
  }

  it('lands once across refused storage, later typing, Retry and a cold reload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parent = await endedAfterRelease()
    const launchRows = full()
    refuseDraftWrites(true)
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    // Shown, not saved: the launch still owes it.
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    expect(savedRow()).toMatchObject({ firstMessage: { clientMessageId: MESSAGE_ID } })
    updateNativeChatComposerDraft(
      DRAFT,
      { text: `${draft(SESSION_ID)}\nAnd run tests` },
      'immediate'
    )
    launchRows.mockRestore()
    refuseDraftWrites(false)

    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    const once = `Also run lint\n\n${HELD}\nAnd run tests`
    expect(draft(SESSION_ID)).toBe(once)
    await coldReload()
    expect(draft(SESSION_ID)).toBe(once)
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(host.release).toHaveBeenCalledOnce()
    expect(windowCalls()).not.toContain('agentSession.create')
    expect(windowCalls()).not.toContain('agentSession.send')
    warn.mockRestore()
  })

  it('lets the launch go of the opening only once its return is complete, and returns it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parent = await endedAfterRelease()
    // The draft store refuses every write; only its journal holds the return, as one complete
    // copy of the draft with the receipt that replaces the identified addition.
    refuseDraftWrites(true)
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    window.dispatchEvent(new Event('pagehide'))

    // A restart: the complete copy lands once, and nothing returns it again.
    refuseDraftWrites(false)
    await coldReload()
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    await coldReload()
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    expect(host.release).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('keeps an independent draft equal to the opening beside it', async () => {
    const parent = await endedAfterRelease(HELD)
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    expect(draft(SESSION_ID)).toBe(`${HELD}\n\n${HELD}`)
  })

  it('does not bring it back after a reload when only the launch row could not be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parent = await endedAfterRelease()
    // The composer saves the message; the launch's own row cannot drop it.
    const launchRows = full()
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    launchRows.mockRestore()
    expect(savedRow()).toMatchObject({ firstMessage: { clientMessageId: MESSAGE_ID } })

    await coldReload()
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
    expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
    expect(host.release).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('a return to the composer whose save is still on its way', () => {
  it.each([3, 30])(
    'observes that one save once across %i Retries, and nothing of it after Close',
    async (count) => {
      const scope = `agent-session:${SESSION_ID}`
      const parent = deferred<AgentLaunchReleasePhaseStatusResult>()
      host.status.mockResolvedValueOnce(AWAITING).mockReturnValue(parent.promise)
      host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
      startReleaseLaunch()
      await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
      // The draft's save is held; its journal fallback is refused.
      const held = Promise.withResolvers<void>()
      const backend = nativeChatComposerDraftStorage()
      const update = backend.update.bind(backend)
      // Reactions on the promise the store derives from that save (its written result), each
      // still delegated to the native then.
      let writtenReactions = 0
      const blocked = vi.spyOn(backend, 'update').mockImplementation((key, apply) => {
        if (key !== scope) {
          return update(key, apply)
        }
        const raw = held.promise.then(() => update(key, apply))
        const rawThen = raw.then.bind(raw)
        vi.spyOn(raw, 'then').mockImplementation((fulfilled, rejected) => {
          const written = rawThen(fulfilled, rejected)
          const writtenThen = written.then.bind(written)
          vi.spyOn(written, 'then').mockImplementation((next, failed) => {
            writtenReactions += 1
            return writtenThen(next, failed)
          })
          return written
        })
        return raw
      })
      const setItem = localStorage.setItem.bind(localStorage)
      const journal = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
        if (key === 'orca:nativeChatComposerDraftJournal:v1') {
          throw new DOMException('full', 'QuotaExceededError')
        }
        setItem(key, value)
      })
      // Native reactions on the held save, which nothing can remove once added.
      let reactions = 0
      const then = held.promise.then.bind(held.promise)
      vi.spyOn(held.promise, 'then').mockImplementation((fulfilled, rejected) => {
        reactions += 1
        return then(fulfilled, rejected)
      })
      parent.resolve({ state: 'unknown' })
      await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      expect(draft(SESSION_ID)).toBe(`Also run lint\n\n${HELD}`)
      expect(getStructuredLaunchStateBySessionId(SESSION_ID)?.intent.opening).toBeDefined()
      const initial = reactions
      const writtenInitial = writtenReactions
      const owners = receiptListeners.live
      host.status.mockResolvedValue({ state: 'unknown' })
      for (let index = 0; index < count; index++) {
        expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
        await vi.waitFor(() =>
          expect(getStructuredLaunchStateBySessionId(SESSION_ID)?.callers.outcome).toBe('unknown')
        )
      }
      // One current input, one pending save: its observation does not grow with Retries.
      expect(reactions - initial).toBeLessThanOrEqual(1)
      expect(writtenReactions).toBe(writtenInitial)
      expect(receiptListeners.live).toBeLessThanOrEqual(Math.max(owners, 1))
      expect(blocked).toHaveBeenCalledTimes(1)

      expect(cancelStructuredAgentLaunch('workspace-1', SESSION_ID)).toBe(true)
      expect(receiptListeners.live).toBe(0)
      const afterClose = reactions
      // The held save may still finish; nothing of the closed launch comes back.
      journal.mockRestore()
      held.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(reactions).toBe(afterClose)
      expect(writtenReactions).toBe(writtenInitial)
      expect(receiptListeners.live).toBe(0)
      expect(getStructuredLaunchStateBySessionId(SESSION_ID)).toBeUndefined()
      expect(host.prepare).toHaveBeenCalledOnce()
      expect(host.release).toHaveBeenCalledOnce()
      blocked.mockRestore()
    }
  )
})
