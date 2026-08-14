import {
  parseTerminalOscColorQuery,
  type TerminalOscColorQueryReplyColors,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import {
  answerLiveOscColorQuery,
  answerStartupOscColorQuery
} from './pty-startup-ingress-color-answer'
import {
  applyPtyStartupIngressOperation,
  type PtyStartupIngressOperationHost
} from './pty-startup-ingress-operations'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { PtyOwnerBackend } from './pty-owner-backend'
import { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import { answerEachCookedEchoSafeQueryReply } from './terminal-query-reply'
import {
  combinePtyIngressSourceSpans,
  slicePtyIngressSourceSpan,
  type PtyIngressEmission,
  type PtyIngressSourceSpan,
  type PtyStartupIngressOperation,
  type PtyStartupIngressOptions
} from './pty-startup-ingress-contract'

export {
  PTY_STARTUP_INGRESS_VERSION,
  parsePtyStartupIngressIntent
} from './pty-startup-ingress-intent'
export type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
export type { PtyIngressEmission, PtyStartupIngressOptions } from './pty-startup-ingress-contract'

const MAX_QUERY_CANDIDATE_CHARS = 64
// Why this long: a torn echo whose halves straddle this window is released raw, so
// anything under relay jitter reinstates the leak (#12112). Almost nothing is risked
// by waiting, because the timer is rarely what ends a hold — the next read is, and
// the startup deadline and snapshot barrier both cap the wait independently. The
// exposure is at most one projection's worth of echo-shaped bytes on an already idle
// pane, which is why the guess is allowed to be slow rather than tight.
const ECHO_CONTINUATION_HOLD_MS = 500

/**
 * Serialized source-side startup classifier. Its raw sequence begins after
 * shell-ready preprocessing and every accepted range is emitted exactly once.
 */
export class PtyStartupIngress {
  private readonly intent: PtyStartupIngressIntent | undefined
  private readonly liveOscColors: TerminalOscColorQueryReplyColors | undefined
  private readonly ownerBackend: PtyOwnerBackend
  private readonly delivery: PtyStartupReplyDelivery
  private readonly onEmission: (emission: PtyIngressEmission) => void
  private readonly operations: PtyStartupIngressOperation[] = []
  private readonly answeredSlots = new Set<TerminalOscColorQuerySlot>()
  private processing = false
  private closed = false
  private queryOpen: boolean
  private rawHighWater = 0
  private queryPending: PtyIngressSourceSpan | null = null
  private echoPending: PtyIngressSourceSpan | null = null
  private echoHoldTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private readonly operationHost: PtyStartupIngressOperationHost

  constructor(options: PtyStartupIngressOptions) {
    this.intent = options.intent
    this.liveOscColors = options.liveOscColors
    this.ownerBackend = options.ownerBackend ?? 'posix-pty'
    this.delivery = new PtyStartupReplyDelivery(this.ownerBackend, options.write, options.echoProbe)
    this.onEmission = options.onEmission
    this.operationHost = {
      ownerBackend: this.ownerBackend,
      keepLiveQueryHold: Boolean(this.liveOscColors) && this.ownerBackend === 'posix-pty',
      processEchoSpan: (span) => this.processEchoSpan(span),
      endQueryAuthority: () => {
        this.queryOpen = false
      },
      releaseQueryPending: () => this.releaseQueryPending(),
      releaseEchoPendingOnly: () => this.releaseEchoPendingOnly(),
      releasePendingInSourceOrder: (include) => this.releasePendingInSourceOrder(include),
      resetDelivery: () => this.delivery.reset(),
      closeDelivery: () => this.delivery.close(),
      clearDeadline: () => this.clearDeadline(),
      markClosed: () => {
        this.closed = true
      }
    }
    this.queryOpen = options.intent !== undefined
    if (options.intent) {
      this.deadlineTimer = setTimeout(
        () => this.enqueue({ kind: 'expire' }),
        Math.max(0, options.intent.deadlineMs)
      )
      this.deadlineTimer.unref?.()
    }
  }

  get acceptedRawSequence(): number {
    return this.rawHighWater
  }

  accept(data: string): void {
    if (this.closed || data.length === 0) {
      return
    }
    const rawStartSeq = this.rawHighWater
    this.rawHighWater += data.length
    this.enqueue({
      kind: 'data',
      chunk: { data, rawStartSeq, rawEndSeq: this.rawHighWater }
    })
  }

  closeQueryAuthority(): number {
    this.enqueue({ kind: 'close-query' })
    return this.rawHighWater
  }

  snapshotBarrier(): number {
    this.enqueue({ kind: 'snapshot' })
    return this.rawHighWater
  }

  // Live color replies reuse startup's cooked-echo containment (#13137).
  answerLiveQueryReply(reply: string): boolean {
    return !this.closed && reply.length > 0
      ? answerEachCookedEchoSafeQueryReply(reply, (part) => this.delivery.answer(part))
      : false
  }

  drainAndClose(): number {
    this.enqueue({ kind: 'teardown' })
    return this.rawHighWater
  }

  private enqueue(operation: PtyStartupIngressOperation): void {
    if (this.closed) {
      return
    }
    this.operations.push(operation)
    if (this.processing) {
      return
    }
    this.processing = true
    try {
      let next: PtyStartupIngressOperation | undefined
      while ((next = this.operations.shift())) {
        this.applyOperation(next)
      }
    } finally {
      this.processing = false
    }
  }

  private applyOperation(operation: PtyStartupIngressOperation): void {
    applyPtyStartupIngressOperation(this.operationHost, operation)
  }

  /**
   * One PTY read. The charge is in `finally` because every path below can return
   * early: charging after the match gives a real echo the whole read it arrives in,
   * and charging unconditionally means a projection that never lands still ages out
   * on the reads that end mid-candidate rather than shadowing the rest of the session.
   * It charges the read, never the held-bytes-plus-read span, so a tail that waits
   * across several reads is not billed again on each one.
   */
  private processEchoSpan(span: PtyIngressSourceSpan): void {
    try {
      this.classifyRead(span)
    } finally {
      this.delivery.chargeEchoSearch(span.data.length)
    }
  }

  private classifyRead(span: PtyIngressSourceSpan): void {
    let input = combinePtyIngressSourceSpans(this.takeEchoPending(), span)

    while (this.delivery.hasExpectedEcho && input.data.length > 0) {
      const match = this.delivery.matchEcho(input.data)
      if (match.kind !== 'complete') {
        // Why hold from the match rather than only at offset 0: the tty coalesces its
        // echo with whatever the shell printed around it, so a split echo almost
        // always arrives behind other bytes. Those bytes are emitted now and only the
        // candidate tail waits, so recognition survives a split at any boundary
        // without stalling real output.
        if (match.kind === 'partial') {
          const tail = slicePtyIngressSourceSpan(input, match.offset)
          if (match.offset > 0) {
            this.processQuerySpan(slicePtyIngressSourceSpan(input, 0, match.offset))
          }
          // A still-torn query outranks the echo only while it can still become one:
          // the tail may open with the BEL that terminates it, since the readline
          // projection starts with one. Re-parsing it against the tail is what tells
          // the two apart — a candidate the tail *disproves* is ordinary output that
          // would otherwise absorb the echo behind it and dump both raw (#12112).
          //
          // `partial` counts as viable, not just `match`: the terminator can arrive a
          // read later, and demoting it would emit a bare ESC and leave a real query
          // unanswered until the program's own timeout. On ConPTY that costs an echo,
          // because the ESC-stripped projection shares the `]10;` prefix with a real
          // query and so keeps re-parsing as `partial` — a hang is the worse of the two.
          if (this.queryPending) {
            const resolved = combinePtyIngressSourceSpans(this.queryPending, tail)
            if (parseTerminalOscColorQuery(resolved.data, 0).kind !== 'none') {
              this.processQuerySpan(tail)
              return
            }
            // Unconditional, unlike `releasePendingInSourceOrder`, which withholds a
            // ConPTY candidate: that one releases candidates still *undetermined*,
            // and on ConPTY an undetermined candidate may be a query it is meant to
            // suppress. Here the candidate and the tail together parse as `none`, so
            // whatever the candidate is, the bytes behind it are not its body — which
            // is what makes it safe to stop holding the echo hostage to it.
            this.releaseQueryPending()
          }
          this.echoPending = tail
          this.armEchoHold()
          return
        }
        break
      }
      if (match.offset > 0) {
        this.processQuerySpan(slicePtyIngressSourceSpan(input, 0, match.offset))
      }
      // Why release first: a retained torn candidate cannot straddle the suppressed
      // range without desynchronizing its raw sequence arithmetic.
      this.releaseQueryPending()
      const echoEnd = match.offset + match.length
      this.emit(slicePtyIngressSourceSpan(input, match.offset, echoEnd), true, '')
      input = slicePtyIngressSourceSpan(input, echoEnd)
    }

    if (input.data.length > 0) {
      this.processQuerySpan(input)
    }
  }

  private processQuerySpan(span: PtyIngressSourceSpan): void {
    const input = combinePtyIngressSourceSpans(this.queryPending, span)
    this.queryPending = null
    const canAnswerColorQuery =
      (Boolean(this.liveOscColors) && this.ownerBackend === 'posix-pty') ||
      Boolean(this.queryOpen && this.intent)
    if (!canAnswerColorQuery && this.ownerBackend !== 'windows-conpty') {
      this.emit(input, false)
      return
    }

    let scanOffset = 0
    let emittedOffset = 0
    while (scanOffset < input.data.length) {
      const candidateIndex = input.data.indexOf('\x1b', scanOffset)
      if (candidateIndex === -1) {
        this.emit(slicePtyIngressSourceSpan(input, emittedOffset), false)
        return
      }
      const query = parseTerminalOscColorQuery(input.data, candidateIndex)
      if (query.kind === 'none') {
        scanOffset = candidateIndex + 1
        continue
      }
      if (query.kind === 'partial') {
        if (candidateIndex > emittedOffset) {
          this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
        }
        const candidate = slicePtyIngressSourceSpan(input, candidateIndex)
        if (candidate.data.length <= MAX_QUERY_CANDIDATE_CHARS) {
          this.queryPending = candidate
        } else {
          this.emit(candidate, false)
        }
        return
      }

      if (candidateIndex > emittedOffset) {
        this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
      }
      const querySpan = slicePtyIngressSourceSpan(input, candidateIndex, query.endIndex)
      // Startup is once-per-slot. A later genuine query of the same slot
      // must still be host-answered, or the renderer sees it and can send a
      // late `\x1b]` reply into a survey reader.
      const answered =
        (this.queryOpen && this.intent
          ? answerStartupOscColorQuery({
              slots: query.slots,
              intent: this.intent,
              answeredSlots: this.answeredSlots,
              delivery: this.delivery,
              onBothSlotsAnswered: () => {
                this.queryOpen = false
              }
            })
          : false) ||
        answerLiveOscColorQuery({
          slots: query.slots,
          colors: this.liveOscColors,
          ownerBackend: this.ownerBackend,
          delivery: this.delivery
        })
      const suppressQuery = answered || this.ownerBackend === 'windows-conpty'
      this.emit(querySpan, suppressQuery, suppressQuery ? '' : querySpan.data)
      scanOffset = query.endIndex
      emittedOffset = query.endIndex
    }
  }

  private releaseEchoPendingOnly(): void {
    const pending = this.takeEchoPending()
    if (pending) {
      this.emit(pending, false)
    }
  }

  private releaseQueryPending(): void {
    if (!this.queryPending) {
      return
    }
    const pending = this.queryPending
    this.queryPending = null
    this.emit(pending, false)
  }

  /**
   * Why this order: were both ever live, queryPending would hold the earlier source
   * bytes. `classifyRead` only ever arms one — it either keeps a viable query and
   * returns, or releases a disproven one before holding the echo — so this is defense
   * against a future second arming site, not a live inversion.
   */
  private releasePendingInSourceOrder(includeConptyQuery: boolean): void {
    if (includeConptyQuery || this.ownerBackend !== 'windows-conpty') {
      this.releaseQueryPending()
    }
    const pending = this.takeEchoPending()
    if (pending) {
      this.emit(pending, false)
    }
  }

  private takeEchoPending(): PtyIngressSourceSpan | null {
    const pending = this.echoPending
    this.echoPending = null
    if (this.echoHoldTimer) {
      clearTimeout(this.echoHoldTimer)
      this.echoHoldTimer = null
    }
    return pending
  }

  private armEchoHold(): void {
    if (this.echoHoldTimer) {
      return
    }
    this.echoHoldTimer = setTimeout(
      () => this.enqueue({ kind: 'release-echo' }),
      ECHO_CONTINUATION_HOLD_MS
    )
    this.echoHoldTimer.unref?.()
  }

  private emit(span: PtyIngressSourceSpan, transformed: boolean, data = span.data): void {
    this.onEmission({
      data,
      rawStartSeq: span.rawStartSeq,
      rawEndSeq: span.rawEndSeq,
      transformed
    })
  }

  private clearDeadline(): void {
    if (!this.deadlineTimer) {
      return
    }
    clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
  }
}
