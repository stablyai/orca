import type { PtyInputSource } from './pty-input-source'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  isSameRemoteRuntimeInputEndpoint,
  type RemoteRuntimeInputEndpoint
} from './remote-runtime-recovery-input-hold'

export * from './remote-runtime-input-journal-contract'
import {
  REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS,
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS,
  REMOTE_RUNTIME_INPUT_ACK_STALL_MS,
  REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION,
  type RemoteRuntimeInputStream,
  type RemoteRuntimeInputJournal
} from './remote-runtime-input-journal-contract'

type Entry = { seq: number; text: string; source?: PtyInputSource }

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

  const withdraw = (entry: Entry): void => {
    const index = entries.indexOf(entry)
    if (index === -1) {
      return
    }
    codeUnits -= entry.text.length
    entries.splice(index, 1)
    settle(entry.seq, false)
  }
  const retireEntry = (entry: Entry): void => {
    codeUnits -= entry.text.length
    entry.text = ''
    settle(entry.seq, false)
  }
  const replayText = (entry: Entry | undefined): string => {
    if (entry?.source && !entry.source.isCurrent()) {
      retireEntry(entry)
    }
    return entry?.text ?? ''
  }

  const bind = (endpoint: RemoteRuntimeInputEndpoint, ledgerId: string | null): void => {
    // Why skip null: a stream retired by a failed send reports no ledger, which is not a new one.
    if (ledgerId === null) {
      return
    }
    if (bound && bound.ledgerId !== ledgerId) {
      dropEntries()
      ackedSeq = nextSeq - 1
    } else if (bound && !isSameRemoteRuntimeInputEndpoint(bound.endpoint, endpoint)) {
      discardUnscoped()
      if (entries.length === 0) {
        ackedSeq = nextSeq - 1
      }
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
      for (const entry of [...entries]) {
        if (entry.source && !entry.source.isCurrent()) {
          retireEntry(entry)
        }
      }
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
    const retained = entries.slice()
    let index = 0
    for (let seq = ackedSeq + 1; seq < nextSeq; seq += 1) {
      const entry = retained[index]?.seq === seq ? retained[index++] : undefined
      if (!stream.sendInput(replayText(entry), seq)) {
        resumedStream = null
        return
      }
    }
  }

  const discard = (): void => {
    refusalRounds = 0
    dropEntries()
    clearTimer()
    resumedStream = null
  }
  const discardUnscoped = (): void => {
    for (const entry of [...entries]) {
      if (!entry.source || !entry.source.isCurrent()) {
        withdraw(entry)
      }
    }
    if (entries.length === 0) {
      discard()
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
          const text = segment.source && !segment.source.isCurrent() ? '' : segment.text
          entries.push({
            seq,
            text,
            ...(segment.source ? { source: segment.source } : {})
          })
          codeUnits += text.length
        }
        // Why keep journaling after a failed send: the next stream resends the rest in order.
        open =
          open &&
          stream.sendInput(segment.source && !segment.source.isCurrent() ? '' : segment.text, seq)
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
          settle(
            entry.seq,
            kind === 'applied' &&
              entry.seq === appliedSeq &&
              (!entry.source || entry.source.isCurrent())
          )
        }
        entries = entries.slice(settled)
        clearTimer()
      }
      for (const entry of [...entries]) {
        if (entry.source && !entry.source.isCurrent()) {
          retireEntry(entry)
        }
      }
      if (kind === 'resend' && !resendRequested) {
        const onlyRetiredScopes =
          entries.length === nextSeq - 1 - ackedSeq &&
          entries.length > 0 &&
          entries.every((entry) => entry.source && !entry.source.isCurrent())
        refusalRounds = onlyRetiredScopes ? 0 : refusalRounds + 1
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
      const entry = entries.find((entry) => entry.seq === seq)
      if (entry?.source && !entry.source.isCurrent()) {
        retireEntry(entry)
        return Promise.resolve(false)
      }
      if (!entry || !entries.includes(entry)) {
        return Promise.resolve(false)
      }
      return new Promise((resolve) => {
        waiters.set(seq, resolve)
      })
    },
    hasUnacknowledgedInput() {
      for (const entry of [...entries]) {
        if (entry.source && !entry.source.isCurrent()) {
          retireEntry(entry)
        }
      }
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
    discardUnscoped,
    discard
  }
}
