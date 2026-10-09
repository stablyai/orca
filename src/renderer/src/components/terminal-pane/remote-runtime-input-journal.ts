import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalInputAckKind } from '../../../../shared/terminal-stream-protocol'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/remote-runtime-terminal-multiplexer'
import {
  isSameRemoteRuntimeInputEndpoint,
  type RemoteRuntimeInputEndpoint
} from './remote-runtime-recovery-input-hold'

// Why: a retention budget for input in flight across one outage, not a paste ceiling. Past it the
// oldest bytes go, and nothing after that gap is replayed (it would run without its prefix).
export const REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS = 1024 * 1024

// Why backoff: a host refuses input mostly while its PTY is briefly unwritable (an SSH provider
// reconnecting), and each resend refused again costs a round trip.
export const REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS: readonly number[] = [
  100, 250, 500, 1000, 2000, 4000, 8000
]
// Why: a lost frame or ack must not strand input on a healthy link; resending is safe because the
// host dedupes by sequence.
export const REMOTE_RUNTIME_INPUT_ACK_STALL_MS = 5000
// Why: some refusals never clear while the stream stays open (a stale handle, an unwritable PTY);
// past the whole backoff ladder (~16 s) the pane must fall back to its remount path.
export const REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION =
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS.length + 1

export type RemoteRuntimeInputStream = Pick<
  RemoteRuntimeMultiplexedTerminal,
  'sendInput' | 'inputLedgerId'
>

export type RemoteRuntimeInputSegment = { text: string; queryReply: boolean }

/**
 * Go-back-N sender for one pane's input to a host that acks it. Every unacked input is kept in
 * order and resent from the host's cumulative ack on a resend request, on a new stream, or when
 * acks stall. Input that must not run again (a stale query reply, a withdrawn paste, bytes past the
 * retention budget) is resent as empty text so the host can move past its slot.
 */
export type RemoteRuntimeInputJournal = {
  readonly sessionId: string
  /** Assigns the next sequences to `segments` and sends them, after any input `stream` still owes. */
  send: (
    stream: RemoteRuntimeInputStream,
    endpoint: RemoteRuntimeInputEndpoint,
    segments: readonly RemoteRuntimeInputSegment[]
  ) => number[]
  /** Resends unacked input once on a stream it has not used yet (a replacement after an outage). */
  resume: (stream: RemoteRuntimeInputStream, endpoint: RemoteRuntimeInputEndpoint) => void
  acknowledge: (appliedSeq: number, kind: TerminalInputAckKind) => void
  /** True once the host applies `seq`; false if it is withdrawn, dropped, or of unknown delivery. */
  whenAcknowledged: (seq: number) => Promise<boolean>
  /** Withdraws `seq` for its caller; a resend fills its slot with nothing. */
  cancel: (seq: number) => void
  discard: () => void
}

type Entry = { seq: number; text: string }

export function createRemoteRuntimeInputJournal(deps: {
  /** The stream a timed resend goes to, or null while there is none (the next `resume` resends). */
  currentStream: () => {
    stream: RemoteRuntimeInputStream
    endpoint: RemoteRuntimeInputEndpoint
  } | null
  /** Called once per stall when the host keeps refusing input with no progress. */
  onRefusalsPersist?: () => void
}): RemoteRuntimeInputJournal {
  const sessionId = createBrowserUuid()
  let bound: { endpoint: RemoteRuntimeInputEndpoint; ledgerId: string } | null = null
  let entries: Entry[] = []
  let codeUnits = 0
  let nextSeq = 1
  let ackedSeq = 0
  let budgetDroppedThrough = 0
  let resumedStream: RemoteRuntimeInputStream | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let resendRequested = false
  let attempts = 0
  let refusalRounds = 0
  const waiters = new Map<number, (applied: boolean) => void>()

  const settle = (seq: number, applied: boolean): void => {
    waiters.get(seq)?.(applied)
    waiters.delete(seq)
  }

  const dropEntries = (): void => {
    for (const entry of entries) {
      settle(entry.seq, false)
    }
    entries = []
    codeUnits = 0
  }

  const bind = (endpoint: RemoteRuntimeInputEndpoint, ledgerId: string | null): void => {
    // Why skip null: a stream retired by a failed send reports no ledger, which is not a new one.
    if (ledgerId === null) {
      return
    }
    if (
      bound &&
      (!isSameRemoteRuntimeInputEndpoint(bound.endpoint, endpoint) || bound.ledgerId !== ledgerId)
    ) {
      // Why: another shell (#10065) or a restarted host runtime has no record of what was sent,
      // so it would run it twice; its sequence space starts at the next input.
      dropEntries()
      ackedSeq = nextSeq - 1
    }
    bound = { endpoint, ledgerId }
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    resendRequested = false
  }

  const backoff = (): number =>
    REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS[
      Math.min(attempts, REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS.length - 1)
    ]

  const schedule = (delay: number, resend: boolean): void => {
    clearTimer()
    resendRequested = resend
    timer = setTimeout(() => {
      timer = null
      resendRequested = false
      const target = deps.currentStream()
      if (target) {
        attempts += 1
        resendOn(target.stream, target.endpoint)
      }
      armStall()
    }, delay)
  }

  const armStall = (): void => {
    if (ackedSeq >= nextSeq - 1) {
      clearTimer()
    } else if (timer === null) {
      schedule(Math.max(REMOTE_RUNTIME_INPUT_ACK_STALL_MS, backoff()), false)
    }
  }

  const resendOn = (
    stream: RemoteRuntimeInputStream,
    endpoint: RemoteRuntimeInputEndpoint
  ): void => {
    bind(endpoint, stream.inputLedgerId())
    resumedStream = stream
    if (budgetDroppedThrough > ackedSeq) {
      dropEntries()
      budgetDroppedThrough = nextSeq - 1
    }
    let index = 0
    for (let seq = ackedSeq + 1; seq < nextSeq; seq += 1) {
      const entry = entries[index]?.seq === seq ? entries[index++] : undefined
      if (!stream.sendInput(entry?.text ?? '', seq)) {
        resumedStream = null
        return
      }
    }
  }

  return {
    sessionId,
    send(stream, endpoint, segments) {
      // Why one ledger for the whole batch: a failed send retires the stream, which then reports none.
      const ledgerId = stream.inputLedgerId()
      if (resumedStream !== stream) {
        resendOn(stream, endpoint)
      }
      bind(endpoint, ledgerId)
      let open = resumedStream === stream
      const seqs = segments.map((segment) => {
        const seq = nextSeq
        nextSeq += 1
        // Why no entry for a query reply: it answers a probe that has timed out by any resend.
        if (!segment.queryReply) {
          entries.push({ seq, text: segment.text })
          codeUnits += segment.text.length
        }
        // Why keep journaling after a failed send: the next stream resends the rest in order.
        open = open && stream.sendInput(segment.text, seq)
        return seq
      })
      if (!open) {
        resumedStream = null
      }
      let dropped = 0
      while (
        codeUnits > REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS &&
        dropped < entries.length - 1
      ) {
        codeUnits -= entries[dropped].text.length
        budgetDroppedThrough = entries[dropped].seq
        settle(budgetDroppedThrough, false)
        dropped += 1
      }
      entries = dropped > 0 ? entries.slice(dropped) : entries
      armStall()
      return seqs
    },
    resume(stream, endpoint) {
      if (resumedStream !== stream) {
        resendOn(stream, endpoint)
        armStall()
      }
    },
    acknowledge(appliedSeq, kind) {
      if (appliedSeq >= nextSeq) {
        return
      }
      if (appliedSeq > ackedSeq) {
        ackedSeq = appliedSeq
        attempts = 0
        refusalRounds = 0
        let settled = 0
        for (; settled < entries.length && entries[settled].seq <= appliedSeq; settled += 1) {
          const entry = entries[settled]
          codeUnits -= entry.text.length
          // Why only its own ack proves it applied: a cumulative ack can cover a write whose
          // delivery-unknown ack died with its connection (a paste opener that never arrived).
          settle(entry.seq, kind === 'applied' && entry.seq === appliedSeq)
        }
        entries = entries.slice(settled)
        clearTimer()
      }
      if (kind === 'resend' && !resendRequested) {
        refusalRounds += 1
        if (refusalRounds === REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION) {
          deps.onRefusalsPersist?.()
        }
        schedule(backoff(), true)
      } else {
        armStall()
      }
    },
    whenAcknowledged(seq) {
      // Why: callers ask right after send(), so a missing entry was already given up.
      if (!entries.some((entry) => entry.seq === seq)) {
        return Promise.resolve(false)
      }
      return new Promise((resolve) => {
        waiters.set(seq, resolve)
      })
    },
    cancel(seq) {
      const index = entries.findIndex((entry) => entry.seq === seq)
      if (index !== -1) {
        codeUnits -= entries[index].text.length
        entries.splice(index, 1)
      }
      settle(seq, false)
    },
    discard() {
      refusalRounds = 0
      dropEntries()
      clearTimer()
      resumedStream = null
    }
  }
}
