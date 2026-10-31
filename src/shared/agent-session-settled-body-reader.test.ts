import * as admission from './remote-runtime/requests/remote-runtime-prepared-request-admission'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createAgentSessionSettledBodyReader,
  getAgentSessionSettledBodyDemandEvidence
} from './agent-session-settled-body-reader'
import { agentSessionJsonPiece } from './agent-session-json-pieces'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  type AgentSessionSettledBodySource,
  type AgentSessionSettledBodyRead
} from './agent-session-settled-body'
import {
  getRemoteRuntimeRequestAdmissionEvidence,
  reserveRemoteRuntimeRetainedBytes
} from './remote-runtime/requests/remote-runtime-prepared-request-admission'

const source: AgentSessionSettledBodySource = {
  contract: AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  version: 'approval-json.v1',
  state: 'resolved',
  sessionId: 'session-alpha',
  epoch: 'epoch-1',
  itemId: 'item-1',
  revision: 2
}
const body = {
  kind: 'approval',
  title: 'Saved values',
  detail: null,
  options: [],
  form: { fields: [{ name: 'value', required: true, schema: { type: 'string' } }] },
  resolution: {
    state: 'resolved',
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null,
    formContent: { value: ' tail\n'.repeat(8000) }
  }
}
const json = JSON.stringify(body)
const readers: ReturnType<typeof createAgentSessionSettledBodyReader>[] = []
afterEach(() => {
  for (const reader of readers.splice(0)) {
    reader.dispose()
  }
  vi.useRealTimers()
})

it('deduplicates selected readers, advances once per piece, and retires complete ownership on last unsubscribe', async () => {
  for (const count of [1, 10]) {
    const read = vi.fn(async (request: AgentSessionSettledBodyRead) => ({
      source,
      ...agentSessionJsonPiece(json, request.cursor)
    }))
    const reader = createAgentSessionSettledBodyReader(read)
    readers.push(reader)
    const stops = Array.from({ length: count }, () => reader.subscribe(source, () => {}))
    await vi.waitFor(() => expect(reader.getSnapshot(source).status).toBe('ready'))
    expect(read).toHaveBeenCalledTimes(Math.ceil(json.length / 24576))
    expect(reader.getSnapshot(source)).toEqual({ status: 'ready', body })
    stops.slice(0, -1).forEach((stop) => stop())
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(1)
    stops.at(-1)!()
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  }
})

it('keeps changed-source semantic errors terminal until a new source is selected', async () => {
  const read = vi.fn(async (request: AgentSessionSettledBodyRead) => ({
    source: { ...source, epoch: 'stale' },
    ...agentSessionJsonPiece(json, request.cursor)
  }))
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const stop = reader.subscribe(source, () => {})
  await vi.waitFor(() => expect(reader.getSnapshot(source).status).toBe('error'))
  expect(read).toHaveBeenCalledTimes(1)
  const next = { ...source, revision: 3 }
  read.mockImplementation(async (request) => ({
    source: next,
    ...agentSessionJsonPiece(json, request.cursor)
  }))
  reader.retry()
  await Promise.resolve()
  expect(read).toHaveBeenCalledTimes(1)
  expect(reader.getSnapshot(source).status).toBe('error')
  stop()
  const stopNew = reader.subscribe(next, () => {})
  await vi.waitFor(() => expect(reader.getSnapshot(next).status).toBe('ready'))
  stopNew()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})

it('bounds production source work at N/10N across sessions while admission drains without rescanning retained leases', async () => {
  const iterate = Set.prototype[Symbol.iterator]
  let leaseVisits = 0,
    sourceVisits = 0
  const iterator = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function () {
    const underlying = iterate.call(this)
    return {
      next() {
        const result = underlying.next()
        if (
          !result.done &&
          typeof result.value === 'object' &&
          result.value !== null &&
          'retainedBytes' in result.value
        ) {
          leaseVisits++
        }
        if (
          !result.done &&
          typeof result.value === 'object' &&
          result.value !== null &&
          'source' in result.value &&
          'running' in result.value
        ) {
          sourceVisits++
        }
        return result
      },
      [Symbol.iterator]() {
        return this
      }
    }
  })
  try {
    for (const count of [2, 20]) {
      let calls = 0,
        running = 0,
        peak = 0,
        publications = 0
      const visitsBefore = sourceVisits
      const reservations = vi.spyOn(admission, 'reserveRemoteRuntimeRetainedBytes')
      const releases = vi.fn()
      const stopRelease = admission.subscribeRemoteRuntimeAdmissionRelease(releases)
      const owned = Array.from({ length: count }, (_, index) => {
        const selected = { ...source, sessionId: `session-${index}` }
        const reader = createAgentSessionSettledBodyReader(async (request) => {
          calls++
          running++
          peak = Math.max(peak, running)
          await Promise.resolve()
          running--
          return { source: selected, ...agentSessionJsonPiece(json, request.cursor) }
        })
        readers.push(reader)
        const stop = reader.subscribe(selected, () => {
          publications++
        })
        return { reader, selected, stop }
      })
      await vi.waitFor(() =>
        expect(
          owned.every(({ reader, selected }) => reader.getSnapshot(selected).status === 'ready')
        ).toBe(true)
      )
      const interest = getAgentSessionSettledBodyDemandEvidence()
      expect(interest).toMatchObject({
        selected: count,
        listeners: count,
        pending: 0,
        queuedDescriptors: 0,
        active: 0
      })
      expect(interest.metadataBytes).toBeLessThan(count * 2048)
      const admissionCalls = reservations.mock.calls.length
      const releaseSignals = releases.mock.calls.length
      expect(admissionCalls).toBeGreaterThanOrEqual(count)
      expect(admissionCalls).toBeLessThanOrEqual(count * 2)
      expect(releaseSignals).toBeGreaterThan(0)
      expect(releases.mock.calls.length).toBeLessThanOrEqual(count * 2)
      stopRelease()
      reservations.mockRestore()
      expect(calls).toBe(count * Math.ceil(json.length / 24576))
      expect(peak).toBeLessThanOrEqual(2)
      expect(publications).toBe(count)
      owned.forEach(({ stop }) => stop())
      // Count actual scheduler scans separately from publications and physical piece calls.
      expect(sourceVisits - visitsBefore).toBeLessThanOrEqual(count * 12 + calls)
      process.stdout.write(
        `${JSON.stringify({ ownerPerf: true, count, calls, admissionCalls, releaseSignals, publications, peak, metadataBytes: interest.metadataBytes, sourceVisits: sourceVisits - visitsBefore, leaseVisits })}\n`
      )
      expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
        pendingRequestCount: 0,
        retainedBytes: 0
      })
    }
    expect(leaseVisits).toBe(0)
  } finally {
    iterator.mockRestore()
  }
})

it('terminates malformed/nonadvancing piece responses without treating them as network retries', async () => {
  vi.useFakeTimers()
  for (const response of [
    null,
    { source, ...agentSessionJsonPiece(json), total: -1 },
    { source, json: 'x', total: 10, nextCursor: 0 }
  ]) {
    const read = vi.fn(async () => response)
    const reader = createAgentSessionSettledBodyReader(read)
    readers.push(reader)
    const stop = reader.subscribe(source, () => {})
    await vi.runAllTimersAsync()
    expect(reader.getSnapshot(source).status).toBe('error')
    expect(read).toHaveBeenCalledTimes(1)
    stop()
  }
})

it('admits source65 while64 small completed selected values remain mounted', async () => {
  const read = vi.fn(async (request: AgentSessionSettledBodyRead) => {
    const { cursor, ...selected } = request
    return { source: selected, ...agentSessionJsonPiece(json, cursor) }
  })
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const selected = Array.from({ length: 65 }, (_, index) => ({
    ...source,
    itemId: `selected-${index}`
  }))
  const stops = selected.map((item) => reader.subscribe(item, () => {}))
  try {
    await vi.waitFor(() => expect(reader.getSnapshot(selected[63]).status).toBe('ready'))
    await vi.waitFor(() => expect(reader.getSnapshot(selected[64]).status).toBe('ready'))
  } finally {
    stops.forEach((stop) => stop())
  }
})

it.each(['bytes', 'count'] as const)(
  'retains duplicate selected demand through initial %s refusal and real ordinary admission release',
  async (pressureKind) => {
    vi.useFakeTimers()
    const pressure =
      pressureKind === 'bytes'
        ? [reserveRemoteRuntimeRetainedBytes(64 * 1024 * 1024)!]
        : Array.from({ length: 512 }, () => reserveRemoteRuntimeRetainedBytes(0)!)
    const abandonedRead = vi.fn(async () => null)
    const abandoned = createAgentSessionSettledBodyReader(abandonedRead)
    readers.push(abandoned)
    abandoned.subscribe(source, () => {})()
    abandoned.subscribe(source, () => {})
    abandoned.clear()
    abandoned.subscribe(source, () => {})
    abandoned.dispose()
    expect(abandonedRead).not.toHaveBeenCalled()
    const order: string[] = []
    const owned = [0, 1].map((index) => {
      const selected = { ...source, sessionId: `pressure-${index}` }
      const reader = createAgentSessionSettledBodyReader(async (request) => {
        if (!request.cursor) {
          order.push(selected.sessionId)
        }
        return { source: selected, ...agentSessionJsonPiece(json, request.cursor) }
      })
      readers.push(reader)
      const listener = vi.fn()
      return {
        selected,
        reader,
        stops: [reader.subscribe(selected, listener), reader.subscribe(selected, listener)]
      }
    })
    try {
      await vi.advanceTimersByTimeAsync(30000)
      expect(order).toEqual([])
      expect(owned.map(({ reader, selected }) => reader.getSnapshot(selected).status)).toEqual([
        'error',
        'error'
      ])
      expect(getAgentSessionSettledBodyDemandEvidence()).toMatchObject({
        selected: 2,
        listeners: 4,
        queuedDescriptors: 0,
        pending: 2
      })
      const metadata = getAgentSessionSettledBodyDemandEvidence().metadataBytes
      owned.forEach(({ reader }) => {
        reader.retry()
        reader.retry()
      })
      await vi.advanceTimersByTimeAsync(30000)
      expect(getAgentSessionSettledBodyDemandEvidence().metadataBytes).toBe(metadata)
      owned[0].stops[0]()
      const signal = vi.fn()
      const stopSignal = admission.subscribeRemoteRuntimeAdmissionRelease(signal)
      pressure.forEach((lease) => lease.release())
      await Promise.resolve()
      expect(signal).toHaveBeenCalledTimes(1)
      stopSignal()
      await vi.runAllTimersAsync()
      expect(order).toEqual(['pressure-0', 'pressure-1'])
      expect(owned.map(({ reader, selected }) => reader.getSnapshot(selected).status)).toEqual([
        'ready',
        'ready'
      ])
    } finally {
      pressure.forEach((lease) => lease.release())
      owned.forEach(({ stops }) => stops.forEach((stop) => stop()))
    }
    expect(getAgentSessionSettledBodyDemandEvidence()).toMatchObject({
      selected: 0,
      listeners: 0,
      metadataBytes: 0,
      pending: 0,
      active: 0
    })
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  }
)

it('bounds queued and running presentation; contact during a timed-out call keeps ERROR until actual late progress and settlement', async () => {
  vi.useFakeTimers()
  const responses: ((value: unknown) => void)[] = []
  const read = vi.fn<(request: AgentSessionSettledBodyRead) => Promise<unknown>>(
    () =>
      new Promise<unknown>((resolve) => {
        responses.push(resolve)
      })
  )
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const queued = { ...source, itemId: 'queued' }
  const stop = reader.subscribe(source, () => {})
  const stopQueued = reader.subscribe(queued, () => {})
  await vi.advanceTimersByTimeAsync(30000)
  const retained = getRemoteRuntimeRequestAdmissionEvidence()
  expect(reader.getSnapshot(source).status).toBe('error')
  expect(reader.getSnapshot(queued).status).toBe('error')
  for (let i = 0; i < 10; i++) {
    reader.retry()
  }
  await vi.advanceTimersByTimeAsync(60000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(reader.getSnapshot(source).status).toBe('error')
  expect(reader.getSnapshot(queued).status).toBe('error')
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(retained)
  // Late valid progress starts exactly one next piece, with a new actual deadline.
  responses[0]({ source, ...agentSessionJsonPiece(json) })
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(2)
  expect(reader.getSnapshot(source).status).toBe('loading')
  await vi.advanceTimersByTimeAsync(30000)
  expect(reader.getSnapshot(source).status).toBe('error')
  reader.retry()
  expect(reader.getSnapshot(source).status).toBe('error')
  stop()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(retained)
  responses[1]({ source: { ...source, epoch: 'old' }, ...agentSessionJsonPiece(json, 24576) })
  await vi.advanceTimersByTimeAsync(0)
  expect(reader.getSnapshot(source).status).toBe('error')
  expect(read).toHaveBeenCalledTimes(3)
  expect(reader.getSnapshot(queued).status).toBe('loading')
  stopQueued()
  reader.clear()
  responses[2]({ source: queued, ...agentSessionJsonPiece(json) })
  await vi.runAllTimersAsync()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
  // clear remains reusable and no historical listener or retired observation survives.
  read.mockImplementation(async (request) => ({
    source,
    ...agentSessionJsonPiece(json, request.cursor)
  }))
  const stopNext = reader.subscribe(source, () => {})
  await vi.runAllTimersAsync()
  expect(reader.getSnapshot(source).status).toBe('ready')
  stopNext()
  expect(getAgentSessionSettledBodyDemandEvidence()).toMatchObject({
    selected: 0,
    listeners: 0,
    pending: 0,
    active: 0
  })
})

it('keeps scheduled backoff and contact from renewing a still-running retry after a transient failure', async () => {
  vi.useFakeTimers()
  let finish!: (piece: unknown) => void
  const read = vi
    .fn<(request: AgentSessionSettledBodyRead) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const stop = reader.subscribe(source, () => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(reader.getSnapshot(source).status).toBe('error')
  reader.retry()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(2)
  const retained = getRemoteRuntimeRequestAdmissionEvidence()
  await vi.advanceTimersByTimeAsync(30000)
  reader.retry()
  await vi.advanceTimersByTimeAsync(30000)
  expect(reader.getSnapshot(source).status).toBe('error')
  expect(read).toHaveBeenCalledTimes(2)
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(retained)
  stop()
  reader.dispose()
  finish({ source, ...agentSessionJsonPiece(json) })
  await vi.runAllTimersAsync()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})
