import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_RUNTIME_INPUT_ACK_STALL_MS,
  REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS,
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS,
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

  it('drops unacked input sent to another terminal or a restarted host runtime', () => {
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
