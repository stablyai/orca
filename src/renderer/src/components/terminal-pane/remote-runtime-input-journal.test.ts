import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_RUNTIME_INPUT_ACK_STALL_MS,
  REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS,
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS,
  REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION,
  createRemoteRuntimeInputJournal
} from './remote-runtime-input-journal'

const endpoint = { handle: 'terminal-1', incarnationId: 'incarnation-1' }

function recordingStream(ledgerId = 'ledger-1') {
  const sent: { seq: number; text: string }[] = []
  let open = true
  return {
    sent,
    close: () => {
      open = false
    },
    stream: {
      sendInput: (text: string, seq?: number) => {
        if (open) {
          sent.push({ seq: seq ?? 0, text })
        }
        return open
      },
      inputLedgerId: () => ledgerId
    }
  }
}

function typed(...texts: string[]) {
  return texts.map((text) => ({ text, queryReply: false }))
}

describe('remote runtime input journal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports typed input the host has not applied, ignoring query replies', () => {
    const current = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => ({ stream: current.stream, endpoint })
    })
    journal.send(current.stream, endpoint, [{ text: '\x1b[1;1R', queryReply: true }])
    expect(journal.hasUnacknowledgedInput()).toBe(false)

    journal.send(current.stream, endpoint, typed('echo alive\r'))
    expect(journal.hasUnacknowledgedInput()).toBe(true)

    journal.acknowledge(2, 'applied')
    expect(journal.hasUnacknowledgedInput()).toBe(false)
  })

  it('resends after the host ack, filling withdrawn input and query replies with empty text', () => {
    let current = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => ({ stream: current.stream, endpoint })
    })
    journal.send(current.stream, endpoint, typed('a', 'b', 'c', 'd'))
    journal.send(current.stream, endpoint, [{ text: '\x1b[1;1R', queryReply: true }])
    journal.acknowledge(1, 'applied')
    journal.cancel(3)

    current = recordingStream()
    journal.resume(current.stream, endpoint)
    expect(current.sent).toEqual([
      { seq: 2, text: 'b' },
      { seq: 3, text: '' },
      { seq: 4, text: 'd' },
      { seq: 5, text: '' }
    ])
  })

  it('resends on the same stream after a refusal, with backoff', () => {
    const link = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => ({ stream: link.stream, endpoint })
    })
    journal.send(link.stream, endpoint, typed('a', 'b'))
    journal.acknowledge(1, 'resend')
    journal.acknowledge(1, 'resend')
    vi.advanceTimersByTime(REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS[0])
    expect(link.sent.slice(2)).toEqual([{ seq: 2, text: 'b' }])

    journal.acknowledge(1, 'resend')
    vi.advanceTimersByTime(REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS[1] - 1)
    expect(link.sent).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(link.sent.slice(3)).toEqual([{ seq: 2, text: 'b' }])
  })

  it('resends when acks stall on a healthy stream, and stops once everything is acked', () => {
    const link = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => ({ stream: link.stream, endpoint })
    })
    const [seq] = journal.send(link.stream, endpoint, typed('a'))
    const acknowledged = journal.whenAcknowledged(seq)
    vi.advanceTimersByTime(REMOTE_RUNTIME_INPUT_ACK_STALL_MS)
    expect(link.sent).toEqual([
      { seq: 1, text: 'a' },
      { seq: 1, text: 'a' }
    ])
    journal.acknowledge(1, 'applied')
    vi.advanceTimersByTime(REMOTE_RUNTIME_INPUT_ACK_STALL_MS * 10)
    expect(link.sent).toHaveLength(2)
    return expect(acknowledged).resolves.toBe(true)
  })

  it('reports input of unknown delivery as failed and never resends it', async () => {
    const link = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => null
    })
    const [first, second] = journal.send(link.stream, endpoint, typed('a', 'b'))
    const results = Promise.all([first, second].map((seq) => journal.whenAcknowledged(seq)))
    journal.acknowledge(1, 'delivery-unknown')
    journal.acknowledge(2, 'applied')
    await expect(results).resolves.toEqual([false, true])
  })

  it('drops unacked input when the host runtime ledger changes', () => {
    const first = recordingStream('ledger-1')
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => null
    })
    journal.send(first.stream, endpoint, typed('make deploy\r'))
    const restarted = recordingStream('ledger-after-restart')
    journal.send(restarted.stream, endpoint, typed('ls\r'))
    expect(restarted.sent).toEqual([{ seq: 2, text: 'ls\r' }])
  })

  it('replays nothing past input dropped over the retention budget, but still fills its slots', () => {
    const first = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => null
    })
    const chunk = 'x'.repeat(REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS / 2)
    journal.send(first.stream, endpoint, typed(chunk, chunk, 'tail'))
    const next = recordingStream()
    journal.resume(next.stream, endpoint)
    expect(next.sent).toEqual([
      { seq: 1, text: '' },
      { seq: 2, text: '' },
      { seq: 3, text: '' }
    ])
  })

  it('keeps journaling after a failed send and resends the rest on the next stream', () => {
    const first = recordingStream()
    const journal = createRemoteRuntimeInputJournal({
      currentStream: () => null
    })
    journal.send(first.stream, endpoint, typed('a'))
    first.close()
    journal.send(first.stream, endpoint, typed('b', 'c'))
    const next = recordingStream()
    journal.resume(next.stream, endpoint)
    expect(next.sent.map((input) => input.text)).toEqual(['a', 'b', 'c'])
  })
})

it('withdraws only retired scoped slots while ordinary metadata and a live successor scope coexist', async () => {
  const { createPtyInputSourceBinding } = await import('./pty-input-source')
  const source = createPtyInputSourceBinding<{ handle: string; incarnationId: string }>({
    same: (a, b) => a.handle === b.handle && a.incarnationId === b.incarnationId,
    unavailable: () => true,
    refine: (_, next) => next,
    create: (get, isCurrent) => ({
      ptyId: get().handle,
      get endpoint() {
        return get()
      },
      isCurrent,
      sendInput: () => false,
      sendInputImmediate: () => false
    })
  })
  const first = recordingStream()
  let current = first
  const refusal = vi.fn()
  const journal = createRemoteRuntimeInputJournal({
    currentStream: () => ({ stream: current.stream, endpoint }),
    onRefusalsPersist: refusal
  })
  source.change({ handle: endpoint.handle, incarnationId: 'inc-1' }, () => {})
  const a = source.current()
  if (!a) {
    throw new Error('Missing first capability')
  }
  const [old] = journal.send(first.stream, endpoint, [
    { text: 'old', queryReply: false, source: a }
  ])
  if (old === undefined) {
    throw new Error('Missing sequence')
  }
  const oldResult = journal.whenAcknowledged(old)
  source.change({ handle: endpoint.handle, incarnationId: 'inc-2' }, () => {})
  const b = source.current()
  if (!b) {
    throw new Error('Missing successor capability')
  }
  journal.send(first.stream, endpoint, [
    { text: 'ordinary', queryReply: false },
    { text: 'scoped-i2', queryReply: false, source: b }
  ])
  current = recordingStream()
  journal.resume(current.stream, endpoint)
  await expect(oldResult).resolves.toBe(false)
  expect(current.sent).toEqual([
    { seq: 1, text: '' },
    { seq: 2, text: 'ordinary' },
    { seq: 3, text: 'scoped-i2' }
  ])
  journal.acknowledge(3, 'applied')
  vi.useFakeTimers()
  const [last] = journal.send(current.stream, endpoint, [
    { text: 'retired-only', queryReply: false, source: b }
  ])
  if (last === undefined) {
    throw new Error('Missing final scoped sequence')
  }
  const result = journal.whenAcknowledged(last)
  source.change(null, () => {}, true)
  try {
    for (let round = 0; round <= REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION; round++) {
      journal.acknowledge(3, 'resend')
      vi.runOnlyPendingTimers()
    }
    await expect(result).resolves.toBe(false)
    expect(current.sent.slice(4).every((entry) => entry.text === '')).toBe(true)
    expect(refusal).not.toHaveBeenCalled()
    journal.acknowledge(last, 'applied')
    journal.discard()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    journal.discard()
    vi.useRealTimers()
  }
})
