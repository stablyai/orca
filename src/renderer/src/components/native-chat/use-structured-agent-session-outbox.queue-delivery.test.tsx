// @vitest-environment happy-dom

// What the wire sees when queueing is available: `delivery` rides the send and
// its operation fingerprint only for a capable host with the setting on, a
// `queued` answer spends the entry, and everything else is byte-for-byte
// today's request — an older host must never see the key at all.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import type { StructuredAgentSessionQueueCapability } from '../../../../shared/structured-agent-session-outbox-delivery'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

type SentParams = {
  envelope: { clientOperationId: string; sessionId: string; payloadFingerprint: string }
  body?: unknown
  delivery?: 'queue-if-active'
}

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { readOutbox } from './structured-agent-session-outbox-storage'

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(cleanup)

const LOCAL_TARGET = { kind: 'local' } as const
const QUEUEING = { capability: 'supported', enabled: true } as const

function queuedReceipt(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 1, state: 'waiting' as const }
    }
  }
}

function renderOutbox(queue: boolean) {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId: 'session-1',
      target: LOCAL_TARGET,
      fence: 1,
      submissions: [],
      queueDelivery: queue ? QUEUEING : { capability: 'unsupported', enabled: true }
    })
  )
}

async function sentParams(): Promise<SentParams> {
  await waitFor(() => expect(mocks.call).toHaveBeenCalled())
  const call = mocks.call.mock.calls[0]
  expect(call?.[1]).toBe('agentSession.send')
  const params = call?.[2]
  if (!params) {
    throw new Error('no send left the outbox')
  }
  return params
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  mocks.call.mockReset()
})

afterEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

describe('outbox queue delivery selection', () => {
  it('stamps `delivery` on the send and its operation fingerprint when queueing is on', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) =>
      queuedReceipt(params.envelope.clientOperationId)
    )
    const { result } = renderOutbox(true)
    expect(result.current.send('queue me')).toBe(true)
    const params = await sentParams()
    expect(params.delivery).toBe('queue-if-active')
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: params.body, delivery: 'queue-if-active' }
      })
    )
    // The host owns the draft now: the queued answer spends the outbox entry.
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
  })

  it("sends exactly today's request when the host lacks the capability or the setting is off", async () => {
    mocks.call.mockImplementation(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: 'ignored',
        submission: {
          clientMessageId: 'ignored',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 1
        }
      }
    }))
    const { result } = renderOutbox(false)
    expect(result.current.send('plain send')).toBe(true)
    const params = await sentParams()
    expect('delivery' in params).toBe(false)
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: params.body }
      })
    )
  })

  it('routes an image send down the immediate path even with queueing on (text-only v1)', async () => {
    mocks.call.mockImplementation(async () => queuedReceipt('unused'))
    const { result } = renderOutbox(true)
    expect(
      result.current.send('with image', [{ path: '/tmp/a.png', previewUri: 'file:///tmp/a.png' }])
    ).toBe(true)
    const params = await sentParams()
    expect('delivery' in params).toBe(false)
  })

  it('retires an entry the host visibly holds as a draft, with no second copy of the text', async () => {
    // A queued send whose acknowledgement was lost: the entry survives under the
    // draft's own id, then the published draft list proves the host owns it.
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const first = renderHook(
      (props: { queuedMessageIds: string[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions: [],
          queueDelivery: { capability: 'supported' as const, enabled: true },
          queuedMessageIds: props.queuedMessageIds
        }),
      { initialProps: { queuedMessageIds: Array.of<string>() } }
    )
    expect(first.result.current.send('lost ack')).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    const entryId = mocks.call.mock.calls[0]?.[2]?.envelope.clientOperationId
    expect(entryId).toBeTruthy()
    expect(first.result.current.outbox).toHaveLength(1)
    first.rerender({ queuedMessageIds: [entryId ?? ''] })
    await waitFor(() => expect(first.result.current.outbox).toHaveLength(0))
    // Retired, not restored: nothing to resend, nothing appended anywhere.
    expect(localStorage.getItem('orca:desktopStructuredAgentSessionOutbox:v1:session-1')).toBeNull()
    // The held draft answered the send, so the next one goes without waiting on the lost reply.
    expect(first.result.current.send('next')).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })

  it("Stop's local step never restores a queued send already in flight — its answer settles it", async () => {
    // The send is on its way; the Stop lands behind it, so the host may already hold
    // it as a paused card. Restoring it locally too would double the text.
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const view = renderHook(
      (props: { queuedMessageIds: string[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions: [],
          composerScopeKey: 'stop-scope',
          queueDelivery: { capability: 'supported' as const, enabled: true },
          queuedMessageIds: props.queuedMessageIds
        }),
      { initialProps: { queuedMessageIds: Array.of<string>() } }
    )
    expect(view.result.current.send('issued text')).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    // A second send waits behind single-flight: the Stop still owns ITS text locally.
    expect(view.result.current.send('never left')).toBe(true)
    act(() => {
      view.result.current.withdrawUnsent()
    })
    // The unissued entry came back to the composer; the issued one stayed put.
    expect(readNativeChatDraftCache('stop-scope')).toBe('never left')
    // The issued one waits for its answer, marked: only the user's Retry sends it again.
    expect(view.result.current.outbox.map((entry) => [entry.state, entry.outlivedStop])).toEqual([
      ['dispatching', true]
    ])
    // The host publishes the issued send as a card: retired, still nothing restored.
    const entryId = mocks.call.mock.calls[0]?.[2]?.envelope.clientOperationId
    view.rerender({ queuedMessageIds: [entryId ?? ''] })
    await waitFor(() => expect(view.result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('stop-scope')).toBe('never left')
  })

  it('while the capability is unknown, an attempted queue send replays what it sent', async () => {
    const view = await attemptedQueueSend()
    view.rerender({ capability: 'unknown' })
    const id = view.result.current.outbox[0]?.clientMessageId ?? ''
    act(() => {
      view.result.current.retry(id)
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const params = mocks.call.mock.calls[1]?.[2]
    expect(params?.envelope.clientOperationId).toBe(id)
    expect(params?.delivery).toBe('queue-if-active')
    expect(params?.envelope.payloadFingerprint).toBe(
      mocks.call.mock.calls[0]?.[2]?.envelope.payloadFingerprint
    )
  })

  it('while the capability is unknown, a new send goes out plain and holds up nothing', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: params.envelope.clientOperationId,
        submission: {
          clientMessageId: params.envelope.clientOperationId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 1
        }
      }
    }))
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [],
        queueDelivery: { capability: 'unknown', enabled: true }
      })
    )
    act(() => {
      result.current.send('first')
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => {
      result.current.send('second')
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    for (const call of mocks.call.mock.calls) {
      expect('delivery' in call[2]).toBe(false)
    }
  })

  it('a host known not to queue gets the Retry without `delivery`; the entry keeps what it sent', async () => {
    // Such a host rejects the strict field before its operation ledger, so a replay carrying it
    // again could only fail the same way.
    const view = await attemptedQueueSend()
    view.rerender({ capability: 'unsupported' })
    const id = view.result.current.outbox[0]?.clientMessageId ?? ''
    act(() => {
      view.result.current.retry(id)
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const params = mocks.call.mock.calls[1]?.[2]
    expect(params?.envelope.clientOperationId).toBe(id)
    expect(params && 'delivery' in params).toBe(false)
    expect(params?.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: params?.body }
      })
    )
    expect(readOutbox('session-1')[0]?.sentDelivery).toBe('queue-if-active')
  })
})

const SUPPORTED: StructuredAgentSessionQueueCapability = 'supported'

/** A queue send whose first attempt failed and now waits on the user's Retry. */
async function attemptedQueueSend() {
  mocks.call.mockImplementationOnce(async () => {
    throw new Error('invalid_argument: Unrecognized key: "delivery"')
  })
  const view = renderHook(
    (props: { capability: StructuredAgentSessionQueueCapability }) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [],
        queueDelivery: { capability: props.capability, enabled: true }
      }),
    { initialProps: { capability: SUPPORTED } }
  )
  expect(view.result.current.send('follow-up')).toBe(true)
  await waitFor(() => expect(view.result.current.blockedClientMessageId).not.toBeNull())
  expect(mocks.call.mock.calls[0]?.[2]?.delivery).toBe('queue-if-active')
  mocks.call.mockImplementation(() => new Promise(() => {}))
  return view
}
