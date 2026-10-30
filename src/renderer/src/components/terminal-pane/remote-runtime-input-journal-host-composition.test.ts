import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalInputSequenceLedger } from '../../../../main/runtime/rpc/methods/terminal/terminal-input-sequence-ledger'
import {
  createRemoteRuntimeInputJournal,
  REMOTE_RUNTIME_INPUT_ACK_STALL_MS,
  REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION,
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS,
  type RemoteRuntimeInputJournal,
  type RemoteRuntimeInputStream
} from './remote-runtime-input-journal'
import type { PtyInputSource } from './pty-input-source'

const a = { handle: 'A', incarnationId: 'i1' }
const b = { handle: 'B', incarnationId: 'i2' }
function hostHarness() {
  const host = new TerminalInputSequenceLedger()
  const frames: { target: string; seq: number; text: string }[] = []
  const writes: string[] = []
  const outcomes: string[] = []
  const pending: Promise<void>[] = []
  let writable = false
  let target = a
  let stream: RemoteRuntimeInputStream
  let journal: RemoteRuntimeInputJournal
  const recovery = vi.fn()
  const connect = (endpoint = target): RemoteRuntimeInputStream => {
    target = endpoint
    stream = {
      inputLedgerId: () => host.id,
      sendInput: (text, seq) => {
        if (seq === undefined) {
          throw new Error('journal sequence missing')
        }
        frames.push({ target: endpoint.handle, seq, text })
        pending.push(
          host
            .admit(endpoint.handle, journal.sessionId, seq, async () => {
              if (text !== '' && !writable) {
                return 'refused'
              }
              if (text !== '') {
                writes.push(`${endpoint.handle}:${text}`)
              }
              return 'applied'
            })
            .then((ack) => {
              outcomes.push(ack.kind)
              journal.acknowledge(ack.appliedSeq, ack.kind)
            })
        )
        return true
      }
    }
    return stream
  }
  journal = createRemoteRuntimeInputJournal({
    currentStream: () => ({ stream, endpoint: target }),
    onRefusalsPersist: recovery
  })
  connect()
  return {
    journal,
    host,
    frames,
    writes,
    outcomes,
    recovery,
    connect,
    get stream() {
      return stream
    },
    useStream: (replacement: RemoteRuntimeInputStream) => {
      stream = replacement
    },
    allow: () => {
      writable = true
    },
    settle: async () => {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0))
      }
    }
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('restores ordinary endpoint discard/jump, including already-withdrawn slots, with real host ACKs', async () => {
  const h = hostHarness()
  const [seq] = h.journal.send(h.stream, a, [{ text: 'old', queryReply: false }])
  const waiter = h.journal.whenAcknowledged(seq)
  await h.settle()
  expect(h.outcomes).toEqual(['resend'])
  h.journal.discardUnscoped()
  await expect(waiter).resolves.toBe(false)
  const before = h.frames.length
  h.journal.resume(h.connect(b), b)
  expect(h.frames).toHaveLength(before)
  expect(vi.getTimerCount()).toBe(0)
  h.allow()
  expect(h.journal.send(h.stream, b, [{ text: 'fresh', queryReply: false }])).toEqual([2])
  await h.settle()
  expect(h.frames.at(-1)).toEqual({ target: 'B', seq: 2, text: 'fresh' })
  expect(h.writes).toEqual(['B:fresh'])
  expect(h.recovery).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('retains a current scoped neighbor through ordinary catch-up, gap/refusal, and legitimate timer wake', async () => {
  const h = hostHarness()
  let oldCurrent = true
  const old: PtyInputSource = {
    ptyId: 'A',
    isCurrent: () => oldCurrent,
    sendInput: () => true,
    sendInputImmediate: () => true
  }
  const current: PtyInputSource = {
    ptyId: 'B',
    isCurrent: () => true,
    sendInput: () => true,
    sendInputImmediate: () => true
  }
  const seqs = h.journal.send(h.stream, a, [
    { text: 'ordinary-old', queryReply: false },
    { text: 'stale', queryReply: false, source: old },
    { text: 'scoped-current', queryReply: false, source: current }
  ])
  const staleWait = h.journal.whenAcknowledged(seqs[1])
  const survivorWait = h.journal.whenAcknowledged(seqs[2])
  await h.settle()
  expect(h.outcomes).toEqual(['resend', 'resend', 'resend'])
  oldCurrent = false
  h.journal.discardUnscoped()
  await expect(staleWait).resolves.toBe(false)
  // B has the same host ledger but an existing concrete-PTY sequence gap.
  await h.host.admit('B', h.journal.sessionId, 1, async () => 'applied')
  h.journal.resume(h.connect(b), b)
  await h.settle()
  expect(h.frames.slice(-3)).toEqual([
    { target: 'B', seq: 1, text: '' },
    { target: 'B', seq: 2, text: '' },
    { target: 'B', seq: 3, text: 'scoped-current' }
  ])
  expect(h.writes).toEqual([])
  expect(vi.getTimerCount()).toBe(1)
  h.allow()
  await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS[0])
  await h.settle()
  await expect(survivorWait).resolves.toBe(true)
  expect(h.writes).toEqual(['B:scoped-current'])
  h.journal.send(h.stream, b, [{ text: 'ordinary-new', queryReply: false }])
  await h.settle()
  expect(h.writes).toEqual(['B:scoped-current', 'B:ordinary-new'])
  expect(h.recovery).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['cancel', 'query', 'retired'] as const)(
  'preserves the actual %s empty-slot refusal policy and later host progress',
  async (mode) => {
    const h = hostHarness()
    let current = true
    const source: PtyInputSource = {
      ptyId: 'A',
      isCurrent: () => current,
      sendInput: () => true,
      sendInputImmediate: () => true
    }
    const [seq] = h.journal.send(h.stream, a, [
      {
        text: 'x',
        queryReply: mode === 'query',
        ...(mode === 'retired' ? { source } : {})
      }
    ])
    await h.settle()
    if (mode === 'cancel') {
      h.journal.cancel(seq)
    }
    current = false
    // A real stream can refuse even an empty frame before reaching the host ledger.
    const refused = { inputLedgerId: () => h.host.id, sendInput: () => false }
    h.useStream(refused)
    h.journal.resume(refused, a)
    for (let round = 0; round < REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION; round += 1) {
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_INPUT_ACK_STALL_MS + 8000)
      h.journal.acknowledge(0, 'resend')
    }
    expect(h.recovery).toHaveBeenCalledTimes(mode === 'retired' ? 0 : 1)
    h.journal.resume(h.connect(a), a)
    await h.settle()
    expect(h.frames.at(-1)).toEqual({ target: 'A', seq: 1, text: '' })
    expect(vi.getTimerCount()).toBe(0)
    h.allow()
    h.journal.send(h.stream, a, [{ text: 'positive', queryReply: false }])
    await h.settle()
    expect(h.writes).toEqual(['A:positive'])
  }
)
