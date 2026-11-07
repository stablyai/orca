import { afterEach, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from '../control/remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../control/remote-runtime-shared-control-test-server'
import { sendRemoteRuntimeRequest, subscribeRemoteRuntimeRequest } from '../remote-runtime-client'
import { RemoteRuntimeRequestConnection } from './remote-runtime-request-connection'
import {
  limitRemoteRuntimeRequestDispatch,
  observeRemoteRuntimeRequestDispatch
} from './remote-runtime-request-dispatch-observation'
import { getRemoteRuntimeRequestAdmissionEvidence } from './remote-runtime-prepared-request-admission'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../e2ee/node/paired-e2ee-node-primitives'
import { GeneratedInputIngress } from '../../../main/runtime/generated-agent-input-notices-ingress'
import { GeneratedAgentInputNotices } from '../../../main/runtime/generated-agent-input-notices'

afterEach(closeSharedControlTestServers)

const SEND = 'terminal.sendGeneratedInput'

// The observer records what the host had received when it was told the frame left.
function observed(server: { requests: { method: string }[] }) {
  const params = { terminal: 'terminal', text: 'exact', submit: true }
  const marks: string[][] = []
  observeRemoteRuntimeRequestDispatch(params, () =>
    marks.push(server.requests.map(({ method }) => method))
  )
  return { params, marks }
}

// XR2: a generated request is marked possibly sent only at its own frame's handoff, on every
// route that can carry it, never for the status or authentication traffic around it.
it('marks dispatch once, at the request’s own frame on the shared socket', async () => {
  const server = await createSharedControlTestServer()
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
  const { params, marks } = observed(server)
  await connection.request('status.get', undefined, 1000)
  expect(marks).toEqual([])
  const answer = await connection.request(SEND, params, 1000)
  expect(answer.ok).toBe(true)
  // Told before the host could answer it, and after the status request it already had.
  expect(marks).toEqual([['status.get']])
  connection.close()
})

it('never marks a request that ended before its frame could be sent', async () => {
  const server = await createSharedControlTestServer({ suppressReadyFrame: true })
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
  const { params, marks } = observed(server)
  const abort = new AbortController()
  const pending = connection.request(SEND, params, 1000, undefined, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow()
  expect(marks).toEqual([])
  expect(server.requests.map(({ method }) => method)).not.toContain(SEND)
  connection.close()
})

it('marks dispatch at the frame of a one-shot, a cached and a cancellable request', async () => {
  const server = await createSharedControlTestServer()
  const oneShot = observed(server)
  expect((await sendRemoteRuntimeRequest(server.pairing, SEND, oneShot.params, 1000)).ok).toBe(true)
  expect(oneShot.marks).toHaveLength(1)

  const cached = observed(server)
  const connection = new RemoteRuntimeRequestConnection(server.pairing)
  expect((await connection.request(SEND, cached.params, 1000)).ok).toBe(true)
  expect(cached.marks).toHaveLength(1)
  connection.close()

  const cancellable = observed(server)
  const subscription = await subscribeRemoteRuntimeRequest(
    server.pairing,
    SEND,
    cancellable.params,
    1000,
    {
      onResponse: () => {},
      onError: () => {}
    }
  )
  expect(cancellable.marks).toHaveLength(1)
  subscription.close()
})

// A one-shot or cached request aborted while its socket is still unready leaves no frame and no mark.
it('never marks a one-shot or cached request aborted before its frame', async () => {
  const server = await createSharedControlTestServer({ suppressReadyFrame: true })
  const oneShot = observed(server)
  const oneShotAbort = new AbortController()
  const oneShotSent = sendRemoteRuntimeRequest(
    server.pairing,
    SEND,
    oneShot.params,
    1000,
    undefined,
    oneShotAbort.signal
  )
  oneShotAbort.abort()
  await expect(oneShotSent).rejects.toThrow()

  const cached = observed(server)
  const connection = new RemoteRuntimeRequestConnection(server.pairing)
  const cachedAbort = new AbortController()
  const cachedSent = connection.request(SEND, cached.params, 1000, cachedAbort.signal)
  cachedAbort.abort()
  await expect(cachedSent).rejects.toThrow()
  connection.close()

  expect(oneShot.marks).toEqual([])
  expect(cached.marks).toEqual([])
  expect(server.requests.map(({ method }) => method)).not.toContain(SEND)
})

// CNG2 at every route a generated request leaves by: its own end is enforced at the actual
// handoff after readiness/authentication, never from the bytes prepared before that wait. A request
// whose end passed sends nothing and gives back its admission; one still in time carries only the
// time left, and its frame's handoff releases the end so it never cuts the host's answer.
function limited(end: number, timeoutMs = 60_000) {
  const params = { terminal: 'terminal', text: 'exact', submit: true, timeoutMs }
  const events: string[] = []
  observeRemoteRuntimeRequestDispatch(params, () => events.push('frame'))
  limitRemoteRuntimeRequestDispatch(params, {
    end,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: withRemaining receives the params object given above.
    withRemaining: (sent, remainingMs) => ({ ...(sent as object), timeoutMs: remainingMs }),
    handedOff: () => events.push('handed-off')
  })
  return { params, events }
}

const sends = (server: { requests: { method: string; params?: unknown }[] }) =>
  server.requests.filter(({ method }) => method === SEND)

it.each(['shared', 'cached', 'one-shot', 'subscription'] as const)(
  'sends a %s request held before its handoff only within its own end',
  async (route) => {
    const server = await createSharedControlTestServer()
    const send = (params: unknown) => {
      if (route === 'shared') {
        const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
        return connection.request(SEND, params, 5000).finally(() => connection.close())
      }
      if (route === 'cached') {
        const connection = new RemoteRuntimeRequestConnection(server.pairing)
        return connection.request(SEND, params, 5000).finally(() => connection.close())
      }
      if (route === 'one-shot') {
        return sendRemoteRuntimeRequest(server.pairing, SEND, params, 5000)
      }
      // Set up once its request frame left after authentication; refused before that.
      return subscribeRemoteRuntimeRequest(server.pairing, SEND, params, 5000, {
        onResponse: () => {},
        onError: () => {}
      }).then(async (subscription) => {
        await vi.waitFor(() => expect(sends(server).length).toBeGreaterThan(0))
        subscription.close()
      })
    }
    const realNow = Date.now.bind(Date)
    // Its end passes while the socket is still connecting and authenticating.
    const expired = limited(realNow() + 60_000)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 120_000)
    try {
      await expect(send(expired.params)).rejects.toMatchObject({ code: 'runtime_timeout' })
    } finally {
      clock.mockRestore()
    }
    expect(sends(server)).toEqual([])
    expect(expired.events).toEqual([])
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(0)

    const inTime = limited(realNow() + 2_000)
    await send(inTime.params)
    const [frame] = sends(server)
    // Serialized at the handoff: only the time left, never the duration prepared earlier.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal.send frame carries the timeoutMs set above.
    expect((frame.params as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(2_000)
    expect(frame.params).toMatchObject({ terminal: 'terminal', text: 'exact', submit: true })
    expect(inTime.events).toEqual(['handed-off', 'frame'])
  }
)

// P18: the end may pass during the synchronous work after the last check, while its bytes are
// serialized or sealed. That frame is dropped unsent on every route, this request alone failing;
// the same connection then carries a successor whose end passes just after its handoff, and the
// host's late answer still arrives.
it.each(
  (['shared', 'cached', 'one-shot', 'subscription'] as const).flatMap((route) =>
    (['serialization', 'seal'] as const).map((order) => [route, order] as const)
  )
)('drops a %s frame whose end passes during its %s', async (route, order) => {
  const server = await createSharedControlTestServer()
  const shared = new RemoteRuntimeSharedControlConnection(server.pairing)
  const cached = new RemoteRuntimeRequestConnection(server.pairing)
  const send = (params: unknown) =>
    route === 'shared'
      ? shared.request(SEND, params, 5000)
      : route === 'cached'
        ? cached.request(SEND, params, 5000)
        : route === 'one-shot'
          ? sendRemoteRuntimeRequest(server.pairing, SEND, params, 5000)
          : subscribeRemoteRuntimeRequest(server.pairing, SEND, params, 5000, {
              onResponse: () => {},
              onError: () => {}
            }).then((subscription) => subscription.close())
  const began = Date.now()
  let now = began
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const expired = limited(began + 1000)
  let armed = true
  const stringify = JSON.stringify
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spy forwards every argument to the real stringify.
  const serialized = vi.spyOn(JSON, 'stringify').mockImplementation(((
    ...args: Parameters<typeof JSON.stringify>
  ) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only request envelopes are inspected, each field optional.
    const value = args[0] as { method?: string; params?: unknown } | undefined
    const text = stringify(...args)
    // The handoff's own bytes: the copy carrying only the time left.
    if (
      order === 'serialization' &&
      armed &&
      value?.method === SEND &&
      value.params !== expired.params
    ) {
      armed = false
      now = began + 1001
    }
    return text
  }) as typeof JSON.stringify)
  const seal = NODE_PAIRED_E2EE_PRIMITIVES.sealLegacyText
  const sealed = vi
    .spyOn(NODE_PAIRED_E2EE_PRIMITIVES, 'sealLegacyText')
    .mockImplementation((plaintext, key) => {
      const frame = seal(plaintext, key)
      if (order === 'seal' && armed && plaintext.includes(`"method":"${SEND}"`)) {
        armed = false
        now = began + 1001
      }
      return frame
    })
  try {
    await expect(send(expired.params)).rejects.toMatchObject({ code: 'runtime_timeout' })
    expect(armed).toBe(false)
    expect(sends(server)).toEqual([])
    expect(expired.events).toEqual([])
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })

    const successor = limited(now + 1000)
    observeRemoteRuntimeRequestDispatch(successor.params, () => {
      successor.events.push('frame')
      now += 5000
    })
    await send(successor.params)
    await vi.waitFor(() => expect(sends(server)).toHaveLength(1))
    expect(successor.events).toEqual(['handed-off', 'frame'])
  } finally {
    serialized.mockRestore()
    sealed.mockRestore()
    clock.mockRestore()
    shared.close()
    cached.close()
  }
})

// RT1: on the shared socket a request is possibly sent from the moment its frame is handed over,
// not once the send returns. Its accepted record therefore reads unconfirmed when the send itself
// throws, and stays not sent when sealing failed before any handoff. One frame, never resent.
async function sharedAccepted(operationId: string) {
  const server = await createSharedControlTestServer()
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
  await connection.request('status.get', undefined, 2000)
  const params = {
    terminal: { handle: 'terminal', expectedRuntimeId: 'runtime-test' },
    text: 'exact',
    submit: true,
    agent: 'claude',
    retainNotice: true,
    operationId,
    window: 'window-a'
  }
  const notices = new GeneratedAgentInputNotices()
  const record = new GeneratedInputIngress(notices).accept(
    SEND,
    params,
    { origin: 'window-a', connection: 'doc' },
    { environmentId: 'env', runtimeId: 'runtime-test', pairingRevision: 1 }
  )!
  const events: string[] = []
  observeRemoteRuntimeRequestDispatch(params, () => {
    events.push('frame')
    record.dispatched()
  })
  limitRemoteRuntimeRequestDispatch(params, {
    end: Date.now() + 5000,
    handedOff: () => events.push('handed-off')
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reaches the connection's own socket to fault its send; a renamed field fails the test.
  const socket = (connection as unknown as { ws: { send: (frame: string) => void } }).ws
  return { server, connection, params, notices, record, events, socket }
}

it.each(['send throws after the frame left', 'sealing throws first'] as const)(
  'reads a shared request whose %s by its actual handoff',
  async (fault) => {
    const w = await sharedAccepted('op-send-throw')
    const send = w.socket.send.bind(w.socket)
    let attempted = 0
    w.socket.send = (frame) => {
      attempted += 1
      send(frame)
      throw new Error('lost synchronous send result')
    }
    const seal = NODE_PAIRED_E2EE_PRIMITIVES.sealLegacyText
    const sealed = vi
      .spyOn(NODE_PAIRED_E2EE_PRIMITIVES, 'sealLegacyText')
      .mockImplementation((plaintext, key) => {
        if (fault === 'sealing throws first' && plaintext.includes(`"method":"${SEND}"`)) {
          throw new Error('seal failed')
        }
        return seal(plaintext, key)
      })
    try {
      await expect(w.connection.request(SEND, w.params, 2000)).rejects.toMatchObject({
        code: 'remote_runtime_unavailable'
      })
      w.record.answered(null)
      w.socket.send = send
      const thrown = fault === 'send throws after the frame left'
      await vi.waitFor(() => expect(sends(w.server)).toHaveLength(thrown ? 1 : 0))
      expect(attempted).toBe(thrown ? 1 : 0)
      expect(w.events).toEqual(thrown ? ['handed-off', 'frame'] : [])
      expect(w.notices.noticeOf('op-send-throw')).toMatchObject({
        text: 'exact',
        certainty: thrown ? 'unconfirmed' : 'not-sent'
      })
      expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
        pendingRequestCount: 0,
        retainedBytes: 0
      })
      // The healthy connection carries the next request; nothing of this one is sent again.
      expect((await w.connection.request('worktree.ps', undefined, 2000)).ok).toBe(true)
      expect(sends(w.server)).toHaveLength(thrown ? 1 : 0)
    } finally {
      sealed.mockRestore()
      w.socket.send = send
      w.connection.close()
    }
  }
)

// Either half of the handoff notification may throw; the other still runs, the frame goes once
// and the host's answer settles the request.
it.each(['handed-off', 'frame'] as const)(
  'sends once and answers when the %s notification throws',
  async (throwing) => {
    const server = await createSharedControlTestServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const params = { terminal: 'terminal', text: 'exact', submit: true }
    const events: string[] = []
    const note = (event: string) => () => {
      events.push(event)
      if (event === throwing) {
        throw new Error('bookkeeping failed')
      }
    }
    observeRemoteRuntimeRequestDispatch(params, note('frame'))
    limitRemoteRuntimeRequestDispatch(params, {
      end: Date.now() + 5000,
      handedOff: note('handed-off')
    })
    try {
      await expect(connection.request(SEND, params, 2000)).resolves.toMatchObject({ ok: true })
      expect(events).toEqual(['handed-off', 'frame'])
      expect(sends(server)).toHaveLength(1)
    } finally {
      connection.close()
    }
  }
)
