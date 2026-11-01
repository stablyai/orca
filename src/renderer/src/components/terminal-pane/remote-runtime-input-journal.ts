import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalInputAckKind } from '../../../../shared/terminal-stream-protocol'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/remote-runtime-terminal-multiplexer-types'
import {
  isSameRemoteRuntimeInputEndpoint,
  type RemoteRuntimeInputEndpoint
} from './remote-runtime-recovery-input-hold'

// Bound retained outage input; dropping its prefix also forbids replaying later command suffixes.
export const REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS = 1024 * 1024

// Back off host refusals because each retry costs a round trip while the PTY is unwritable.
export const REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS: readonly number[] = [
  100, 250, 500, 1000, 2000, 4000, 8000
]
// Resend stalled ACKs safely because the host deduplicates by sequence.
export const REMOTE_RUNTIME_INPUT_ACK_STALL_MS = 5000
// Persistent unwritable/stale handles need remount after the bounded refusal ladder.
export const REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION =
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS.length + 1

export type RemoteRuntimeInputStream = Pick<
  RemoteRuntimeMultiplexedTerminal,
  'sendInput' | 'inputLedgerId'
>

export type RemoteRuntimeInputSegment = { text: string; queryReply: boolean }

/** Replay unacked input in order from cumulative host ACKs across stream replacement/stalls; withdrawn, stale-reply or over-budget slots resend empty so later sequence numbers can advance. */
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
  /** True while input the host has not applied is still held for a resend. */
  hasUnacknowledgedInput: () => boolean
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
      // New terminal/runtime ledgers lack dedup history; skip old writes and start their sequence at fresh input to avoid duplicates (#10065).
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
          // Require the write’s own applied ACK; cumulative progress may cover an earlier delivery-unknown paste opener.
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
    hasUnacknowledgedInput() {
      return entries.some((entry) => entry.text.length > 0)
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
