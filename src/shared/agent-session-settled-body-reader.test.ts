import { afterEach, expect, it, vi } from 'vitest'
import { createAgentSessionSettledBodyReader } from './agent-session-settled-body-reader'
import { agentSessionJsonPiece } from './agent-session-json-pieces'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  type AgentSessionSettledBodySource,
  type AgentSessionSettledBodyRead,
  type AgentSessionSettledBodyPiece
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

it('keeps an abandoned uncancellable piece charged and serializes replacement source work until it ends', async () => {
  let finish!: (piece: AgentSessionSettledBodyPiece) => void
  const read = vi.fn<
    (request: AgentSessionSettledBodyRead) => Promise<AgentSessionSettledBodyPiece>
  >((request) =>
    read.mock.calls.length === 1
      ? new Promise<AgentSessionSettledBodyPiece>((resolve) => {
          finish = resolve
        })
      : Promise.resolve({
          source: { ...source, revision: 3 },
          ...agentSessionJsonPiece(json, request.cursor)
        })
  )
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const stop = reader.subscribe(source, () => {})
  const active = getRemoteRuntimeRequestAdmissionEvidence()
  stop()
  reader.clear()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(active)
  const next = { ...source, revision: 3 }
  const stopNext = reader.subscribe(next, () => {})
  expect(read).toHaveBeenCalledTimes(1)
  finish({ source, ...agentSessionJsonPiece(json) })
  await vi.waitFor(() => expect(reader.getSnapshot(next).status).toBe('ready'))
  expect(reader.getSnapshot(source).status).toBe('error')
  stopNext()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})

it('ends a changed source without publishing its answer and recovers after an actual contact wake', async () => {
  const read = vi.fn(async (request: AgentSessionSettledBodyRead) => ({
    source: { ...source, epoch: 'stale' },
    ...agentSessionJsonPiece(json, request.cursor)
  }))
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const stop = reader.subscribe(source, () => {})
  await vi.waitFor(() => expect(reader.getSnapshot(source).status).toBe('error'))
  expect(read).toHaveBeenCalledTimes(1)
  read.mockImplementation(async (request) => ({
    source,
    ...agentSessionJsonPiece(json, request.cursor)
  }))
  reader.retry()
  await vi.waitFor(() => expect(reader.getSnapshot(source).status).toBe('ready'))
  stop()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})

it('parks admitted source demand under process byte pressure and wakes it on the actual release', async () => {
  const pressure = reserveRemoteRuntimeRetainedBytes(63 * 1024 * 1024)!
  const read = vi.fn(async (request: AgentSessionSettledBodyRead) => ({
    source,
    ...agentSessionJsonPiece(json, request.cursor)
  }))
  const reader = createAgentSessionSettledBodyReader(read)
  readers.push(reader)
  const stop = reader.subscribe(source, () => {})
  try {
    expect(reader.getSnapshot(source).status).toBe('loading')
    expect(read).not.toHaveBeenCalled()
    pressure.release()
    await vi.waitFor(() => expect(reader.getSnapshot(source).status).toBe('ready'))
    expect(read).toHaveBeenCalledTimes(Math.ceil(json.length / 24576))
  } finally {
    pressure.release()
    stop()
  }
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
      expect(calls).toBe(count * Math.ceil(json.length / 24576))
      expect(peak).toBeLessThanOrEqual(2)
      expect(publications).toBe(count)
      owned.forEach(({ stop }) => stop())
      // Count actual scheduler scans separately from publications and physical piece calls.
      expect(sourceVisits - visitsBefore).toBeLessThanOrEqual(64 * (count * 4 + calls))
      console.info('settled owner production operations', {
        count,
        calls,
        publications,
        peak,
        sourceVisits: sourceVisits - visitsBefore
      })
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

it('ends local missing-piece loading at the ordinary deadline without releasing live work on timeout or close', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const reader = createAgentSessionSettledBodyReader(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  readers.push(reader)
  const stop = reader.subscribe(source, () => {})
  const retained = getRemoteRuntimeRequestAdmissionEvidence()
  await vi.advanceTimersByTimeAsync(30000)
  expect(reader.getSnapshot(source).status).toBe('error')
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(retained)
  stop()
  reader.dispose()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(retained)
  finish({ source, ...agentSessionJsonPiece(json) })
  await vi.runAllTimersAsync()
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})
