import * as admission from './remote-runtime/requests/remote-runtime-prepared-request-admission'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createAgentSessionSettledBodyReader,
  getAgentSessionSettledBodyDemandEvidence,
  getAgentSessionSettledBodySchedulingEvidence
} from './agent-session-settled-body-reader'
import { agentSessionJsonPiece } from './agent-session-json-pieces'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  AGENT_SESSION_SETTLED_BODY_MAX_UNITS,
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

it('bounds real 20/200-owner settlement work while retaining every exact READY body', async () => {
  vi.useFakeTimers()
  const iterate = Set.prototype[Symbol.iterator]
  let leaseVisits = 0,
    sourceVisits = 0
  const iterator = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function () {
    const underlying = iterate.call(this)
    return {
      next() {
        const result = underlying.next()
        if (!result.done && typeof result.value === 'object' && result.value !== null) {
          if ('retainedBytes' in result.value) {
            leaseVisits++
          }
          if ('source' in result.value && 'running' in result.value) {
            sourceVisits++
          }
        }
        return result
      },
      [Symbol.iterator]() {
        return this
      }
    }
  })
  const exact = {
    ...body,
    title: 'Saved',
    resolution: { ...body.resolution, formContent: { value: 'exact' } }
  }
  const single = JSON.stringify(exact)
  expect(single.length).toBe(268)
  try {
    for (const count of [20, 200]) {
      let calls = 0,
        publications = 0,
        running = 0,
        peak = 0,
        peakBytes = 0,
        peakAdmissions = 0
      const visitsBefore = sourceVisits
      const before = getAgentSessionSettledBodySchedulingEvidence()
      const reservations = vi.spyOn(admission, 'reserveRemoteRuntimeRetainedBytes')
      const releases = vi.fn()
      const stopRelease = admission.subscribeRemoteRuntimeAdmissionRelease(releases)
      let complete!: () => void
      const completion = new Promise<void>((resolve) => {
        complete = resolve
      })
      const owned = Array.from({ length: count }, (_, index) => {
        const selected = {
          ...source,
          sessionId: `session-${String(index).padStart(3, '0')}`,
          itemId: agentJournalItemKey({
            provider: 'orca',
            clientMessageId: `codex-prompt:thread-a:mcp-elicitation:00000000-0000-4000-8000-000000000000:${String(index).padStart(3, '0')}`
          })
        }
        const reader = createAgentSessionSettledBodyReader(async (request) => {
          calls++
          running++
          peak = Math.max(peak, running)
          const live = getRemoteRuntimeRequestAdmissionEvidence()
          peakBytes = Math.max(peakBytes, live.retainedBytes)
          peakAdmissions = Math.max(peakAdmissions, live.pendingRequestCount)
          await Promise.resolve()
          running--
          return { source: selected, ...agentSessionJsonPiece(single, request.cursor) }
        })
        readers.push(reader)
        const stop = reader.subscribe(selected, () => {
          if (reader.getSnapshot(selected).status === 'ready' && ++publications === count) {
            complete()
          }
        })
        return { reader, selected, stop }
      })
      const queued = getAgentSessionSettledBodySchedulingEvidence()
      expect(queued).toMatchObject({ indexed: count, groups: count, pending: count })
      try {
        await vi.advanceTimersByTimeAsync(0)
        await completion
        const after = getAgentSessionSettledBodySchedulingEvidence()
        const examinations =
          sourceVisits - visitsBefore + after.candidateExaminations - before.candidateExaminations
        const indexSteps = after.indexSteps - before.indexSteps
        const ownerGroups = after.ownerGroups - before.ownerGroups
        const headUpdates = after.headUpdates - before.headUpdates
        const queueOperations = after.queueOperations - before.queueOperations
        const drainRequests = after.drainRequests - before.drainRequests
        const drainRuns = after.drainRuns - before.drainRuns
        const releaseWakes = after.releaseWakes - before.releaseWakes
        expect(drainRequests).toBeLessThanOrEqual(3 * count)
        expect(drainRuns).toBeLessThanOrEqual(count)
        expect(releaseWakes).toBe(releases.mock.calls.length)
        expect(examinations).toBeLessThanOrEqual(count * 12 + calls)
        expect(indexSteps + ownerGroups + headUpdates + queueOperations).toBeLessThanOrEqual(
          32 * count * Math.ceil(Math.log2(count + 1))
        )
        expect(calls).toBe(count)
        expect(publications).toBe(count)
        expect(reservations.mock.calls.length).toBe(count)
        expect(peak).toBeLessThanOrEqual(2)
        expect(peakBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
        expect(peakAdmissions).toBeLessThanOrEqual(512)
        expect(releases.mock.calls.length).toBeGreaterThan(0)
        expect(releases.mock.calls.length).toBeLessThanOrEqual(count)
        expect(after).toMatchObject({ indexed: 0, groups: 0, pending: 0, metadataBytes: 0 })
        const interest = getAgentSessionSettledBodyDemandEvidence()
        expect(interest).toMatchObject({ selected: count, listeners: count, pending: 0, active: 0 })
        expect(interest.metadataBytes).toBeLessThan(count * 2048)
        owned.forEach(({ reader, selected }) =>
          expect(reader.getSnapshot(selected)).toEqual({ status: 'ready', body: exact })
        )
        process.stdout.write(
          `${JSON.stringify({ ownerPerf: true, count, calls, admissionCalls: reservations.mock.calls.length, releases: releases.mock.calls.length, examinations, indexSteps, ownerGroups, headUpdates, queueOperations, drainRequests, drainRuns, releaseWakes, peakIndexMetadataBytes: queued.metadataBytes, peak, peakBytes, peakAdmissions, metadataBytes: interest.metadataBytes })}\n`
        )
      } finally {
        stopRelease()
        reservations.mockRestore()
        owned.forEach(({ stop, reader }) => {
          stop()
          reader.dispose()
        })
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
        pendingRequestCount: 0,
        retainedBytes: 0
      })
      expect(getAgentSessionSettledBodyDemandEvidence()).toMatchObject({
        selected: 0,
        listeners: 0,
        metadataBytes: 0,
        pending: 0,
        active: 0
      })
      expect(getAgentSessionSettledBodySchedulingEvidence()).toMatchObject({
        indexed: 0,
        groups: 0,
        pending: 0,
        metadataBytes: 0
      })
      expect(vi.getTimerCount()).toBe(0)
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

it('progresses the oldest eligible owner past a larger refused source, then wakes the older source on real capacity', async () => {
  vi.useFakeTimers()
  const selections = ['t'.repeat(128), 'thread-a'].map((thread) => ({
    ...source,
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `codex-prompt:${thread}:mcp-elicitation:00000000-0000-4000-8000-000000000000:0`
    })
  }))
  const charge = (selected: AgentSessionSettledBodySource) =>
    JSON.stringify(selected).length * 3 +
    256 +
    6 * AGENT_SESSION_SETTLED_BODY_MAX_UNITS +
    256 * 1024
  expect(charge(selections[0])).toBeGreaterThan(charge(selections[1]))
  const pool = 64 * 1024 * 1024
  const pressure = reserveRemoteRuntimeRetainedBytes(pool)!
  const calls: string[] = []
  const owned = selections.map((selected) => {
    const reader = createAgentSessionSettledBodyReader(async (request) => {
      const { cursor, ...actual } = request
      calls.push(actual.itemId)
      return { source: actual, ...agentSessionJsonPiece(json, cursor) }
    })
    readers.push(reader)
    return { reader, stop: reader.subscribe(selected, () => {}) }
  })
  const sameOwner = {
    ...source,
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId:
        'codex-prompt:thread-extra:mcp-elicitation:00000000-0000-4000-8000-000000000000:1'
    })
  }
  const stopSameOwner = owned[0].reader.subscribe(sameOwner, () => {})
  try {
    await vi.advanceTimersByTimeAsync(30000)
    owned.forEach(({ reader }) => reader.retry())
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    expect(owned.map(({ reader }, i) => reader.getSnapshot(selections[i]).status)).toEqual([
      'error',
      'error'
    ])
    expect(pressure.resize(pool - charge(selections[1]))).toBe(true)
    const proof = reserveRemoteRuntimeRetainedBytes(charge(selections[1]))
    expect(proof).not.toBeNull()
    proof!.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(owned[1].reader.getSnapshot(selections[1])).toEqual({ status: 'ready', body })
    expect(calls).toEqual(Array(Math.ceil(json.length / 24576)).fill(selections[1].itemId))
    expect(owned[0].reader.getSnapshot(selections[0]).status).toBe('error')
    owned.forEach(({ reader }) => reader.retry())
    await vi.advanceTimersByTimeAsync(30000)
    expect(owned[0].reader.getSnapshot(selections[0]).status).toBe('error')
    expect(pressure.resize(pool - charge(selections[0]) - 1024 * 1024)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(owned[0].reader.getSnapshot(selections[0])).toEqual({ status: 'ready', body })
    expect(owned[0].reader.getSnapshot(sameOwner)).toEqual({ status: 'ready', body })
    expect(calls.slice(Math.ceil(json.length / 24576))).toEqual([
      ...Array(Math.ceil(json.length / 24576)).fill(selections[0].itemId),
      ...Array(Math.ceil(json.length / 24576)).fill(sameOwner.itemId)
    ])
  } finally {
    stopSameOwner()
    owned.forEach(({ stop }) => stop())
    pressure.release()
  }
  expect(getAgentSessionSettledBodyDemandEvidence()).toMatchObject({
    selected: 0,
    listeners: 0,
    active: 0,
    pending: 0,
    metadataBytes: 0
  })
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
  expect(vi.getTimerCount()).toBe(0)
})

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
