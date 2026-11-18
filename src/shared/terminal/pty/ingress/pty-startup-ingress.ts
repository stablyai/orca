import { nextQueryCandidate, parsePtyStartupQuery } from './pty-startup-query'
import { PtyOwnerColorQueryReplies } from './pty-owner-color-query-replies'
import { TerminalKittyKeyboardModeTracker } from '../../protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import type { PtyOwnerBackend } from '../lifecycle/pty-owner-backend'
import { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import { PtyQueryAskerWait } from './pty-query-asker-wait'
import type { PtyQueryAskerVerdict } from './pty-query-asker-presence'
import { PtyIngressTornHolds } from './pty-ingress-torn-holds'
import { deliverTerminalQueryReplyPayload } from './terminal-query-reply-delivery'
import {
  combinePtyIngressSourceSpans,
  slicePtyIngressSourceSpan,
  type PtyIngressEmission,
  type PtyIngressSourceSpan,
  type PtyStartupIngressOperation,
  type PtyStartupIngressOptions
} from './pty-startup-ingress-contract'

import './pty-startup-ingress-intent'

// Why a default: every PTY has a startup window, because it bounds the long echo watch.
const DEFAULT_STARTUP_WINDOW_MS = 5_000

/** Serialize source classification after shell-ready preprocessing; emit each accepted range once. Own all lifetime OSC 10/11
 * queries here and strip them so viewers cannot answer twice; a launcher-pinned PTY's OSC 4/12 and ?996n too. Only Kitty
 * authority expires with startup. */
export class PtyStartupIngress {
  private readonly colorQueries: PtyOwnerColorQueryReplies
  private readonly askerWait: PtyQueryAskerWait
  private readonly ownerBackend: PtyOwnerBackend
  private readonly delivery: PtyStartupReplyDelivery
  private readonly onEmission: (emission: PtyIngressEmission) => void
  private readonly operations: PtyStartupIngressOperation[] = []
  private processing = false
  private closed = false
  /** Kitty authority closes with startup; a launcher-pinned PTY's appearance queries stay owned for life. */
  private readonly scope: { kitty: boolean; appearance: boolean }
  private readonly kittyModes = new TerminalKittyKeyboardModeTracker()
  private readonly torn = new PtyIngressTornHolds(
    (kind) => this.enqueue({ kind }),
    (span) => this.emit(span, false)
  )
  private rawHighWater = 0
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PtyStartupIngressOptions) {
    this.askerWait = new PtyQueryAskerWait(options.readForegroundGroup, () =>
      this.enqueue({ kind: 'asker-wait' })
    )
    // Why: command markers ride the colour scan every emission already pays, so tracking them adds no pass.
    this.colorQueries = new PtyOwnerColorQueryReplies(
      options.intent,
      options.resolveHostColors,
      this.askerWait
    )
    this.ownerBackend = options.ownerBackend ?? 'posix-pty'
    this.delivery = new PtyStartupReplyDelivery(
      this.ownerBackend,
      options.write,
      Date.now() + (options.intent?.deadlineMs ?? DEFAULT_STARTUP_WINDOW_MS)
    )
    this.onEmission = options.onEmission
    this.scope = {
      kitty: options.intent?.kittyKeyboardProtocol === true,
      appearance: this.colorQueries.ownsAppearance
    }
    if (options.intent && this.scope.kitty) {
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

  /** `final`: the session's last checkpoint, which must not miss bytes held behind a colour query. */
  snapshotBarrier(final = false): number {
    this.enqueue({ kind: 'snapshot', final })
    return this.rawHighWater
  }

  answerLiveQueryReply(reply: string): boolean {
    return !this.closed && reply.length > 0
      ? deliverTerminalQueryReplyPayload(reply, this.delivery)
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
    switch (operation.kind) {
      case 'data':
      case 'echo':
        if (this.askerWait.waiting) {
          return this.settleAskerWait(this.askerWait.review(operation))
        }
        if (operation.kind === 'echo') {
          // Release torn candidates before suppressed ranges so raw sequence accounting stays aligned.
          this.torn.releaseQuery()
          return this.emit(operation.chunk, true, '')
        }
        return operation.charged
          ? this.classifyRead(operation.chunk)
          : this.processEchoSpan(operation.chunk)
      case 'asker-wait':
        this.settleAskerWait(this.askerWait.judge(true))
        return
      case 'close-query':
        // Only Kitty authority closes; lifetime color replies and already-written echoes remain owner responsibilities.
        this.scope.kitty = false
        if (this.colorQueries.releasesTornCsi(this.torn.query.span?.data)) {
          this.torn.releaseQuery()
        }
        return
      case 'expire':
        this.scope.kitty = false
        this.releasePendingInSourceOrder(false)
        this.clearDeadline()
        return
      case 'snapshot':
        this.releasePendingInSourceOrder(false, operation.final)
        return
      case 'release-echo':
        this.releasePendingInSourceOrder(false)
        return
      case 'release-query':
        this.torn.releaseQuery()
        return
      case 'teardown':
        this.scope.kitty = false
        this.releasePendingInSourceOrder(true)
        this.delivery.close()
        this.clearDeadline()
        this.closed = true
    }
  }

  /** Charge once per read in finally, after matching: complete echoes get their arriving read, and early-returning
   * partial candidates still age out. Never recharge carried bytes on every subsequent read. */
  private processEchoSpan(span: PtyIngressSourceSpan): void {
    try {
      this.classifyRead(span)
    } finally {
      this.delivery.chargeEchoSearch(span.data.length)
    }
  }

  private classifyRead(span: PtyIngressSourceSpan): void {
    let input = combinePtyIngressSourceSpans(this.torn.echo.take(), span)

    while (this.delivery.hasExpectedEcho && input.data.length > 0) {
      const match = this.delivery.matchEcho(input.data)
      if (match.kind !== 'complete') {
        // Echoes follow/coalesce with real shell output; emit the prefix now and retain only the candidate tail across reads.
        if (match.kind === 'partial') {
          const tail = slicePtyIngressSourceSpan(input, match.offset)
          if (match.offset > 0) {
            this.processQuerySpan(slicePtyIngressSourceSpan(input, 0, match.offset))
          }
          // Keep a query ahead of echo only while the combined candidate stays viable, including partial terminators.
          // BEL-led readline echoes can complete real queries; disproven candidates must release before the echo (#12112).
          // ConPTY’s ESC-stripped echo may remain query-shaped, but leaking it is preferable to withholding ESC and timing out.
          if (this.torn.query.span) {
            const resolved = combinePtyIngressSourceSpans(this.torn.query.span, tail)
            if (parsePtyStartupQuery(resolved.data, 0, this.scope).kind !== 'none') {
              this.processQuerySpan(tail)
              return
            }
            // Unlike ordinary ConPTY barrier release, combined candidate+tail is now disproven as a query; release it unconditionally.
            this.torn.releaseQuery()
          }
          this.torn.echo.hold(tail)
          return
        }
        break
      }
      if (match.offset > 0) {
        this.processQuerySpan(slicePtyIngressSourceSpan(input, 0, match.offset))
      }
      const echoEnd = match.offset + match.length
      const echo = slicePtyIngressSourceSpan(input, match.offset, echoEnd)
      if (this.askerWait.waiting) {
        // A colour query in the prefix holds everything after it, this claimed echo included.
        this.applyOperation({ kind: 'echo', chunk: echo })
        const rest = slicePtyIngressSourceSpan(input, echoEnd)
        return this.applyOperation({ kind: 'data', chunk: rest, charged: true })
      }
      // Release torn candidates before suppressed ranges so raw sequence accounting stays aligned.
      this.torn.releaseQuery()
      this.emit(echo, true, '')
      input = slicePtyIngressSourceSpan(input, echoEnd)
    }

    if (input.data.length > 0) {
      this.processQuerySpan(input)
    }
  }

  /** A colour query whose asker may be exiting holds the rest of the span; callers defer what follows. */
  private processQuerySpan(span: PtyIngressSourceSpan): void {
    const input = combinePtyIngressSourceSpans(this.torn.query.take(), span)
    const suppressConptyQuery = this.ownerBackend === 'windows-conpty'

    let scanOffset = 0
    let emittedOffset = 0
    while (scanOffset < input.data.length) {
      const candidateIndex = nextQueryCandidate(input.data, scanOffset, this.scope)
      if (candidateIndex === -1) {
        this.emit(slicePtyIngressSourceSpan(input, emittedOffset), false)
        return
      }
      const query = parsePtyStartupQuery(input.data, candidateIndex, this.scope)
      if (query.kind === 'none') {
        scanOffset = candidateIndex + 1
        continue
      }
      if (query.kind === 'partial') {
        if (candidateIndex > emittedOffset) {
          this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
        }
        const candidate = slicePtyIngressSourceSpan(input, candidateIndex)
        if (this.colorQueries.holdsCandidate(candidate.data)) {
          this.torn.query.hold(candidate)
        } else {
          this.emit(candidate, false)
        }
        return
      }

      if (candidateIndex > emittedOffset) {
        this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
      }
      const querySpan = slicePtyIngressSourceSpan(input, candidateIndex, query.endIndex)
      const asker =
        query.kind === 'kitty'
          ? 'present'
          : this.askerWait.consider(input, candidateIndex, query.endIndex)
      if (asker === 'held') {
        return
      }
      // What stands in for an answered query: nothing, or a mixed OSC's SETs for the viewers. An exited asker's
      // query is consumed unanswered: its reply could only reach the next reader as typed input.
      const replacement =
        query.kind === 'kitty'
          ? this.delivery.answer(`\x1b[?${this.kittyModes.flags}u`, 'owner')
            ? ''
            : null
          : this.colorQueries.answer(query, (reply) =>
              asker === 'gone' ? true : this.delivery.answer(reply, 'owner')
            )
      if (query.kind === 'kitty' && replacement !== null) {
        this.scope.kitty = false
      }
      // A failed write passes the query on, except under ConPTY, whose ESC-stripped
      // echo of a downstream reply would leak into a cooked shell (#9651).
      const seen = query.kind === 'appearance'
      if (replacement !== null || (suppressConptyQuery && query.kind !== 'kitty')) {
        this.emit(querySpan, true, replacement ?? this.colorQueries.forwardedSets(query), seen)
      } else {
        this.emit(querySpan, false, querySpan.data, seen)
      }
      scanOffset = query.endIndex
      emittedOffset = query.endIndex
    }
  }

  private settleAskerWait(verdict: PtyQueryAskerVerdict | null): void {
    const held = verdict && this.askerWait.settle(verdict)
    if (held) {
      this.processQuerySpan(held.from)
      held.later.forEach((read) => this.applyOperation(read))
    }
  }

  /** Settle held askers first: a barrier ends only a wait proven gone, a final snapshot (the PTY may outlive it, as on
   *  sleep) judges each as it stands, teardown drops them.
   * Anything still behind a held asker stays held. Retain torn colors across barriers unless explicitly included:
   * viewers lack reply authority, so only hold timeout/teardown ends them. */
  private releasePendingInSourceOrder(includeColorQuery: boolean, drain = includeColorQuery): void {
    do {
      this.settleAskerWait(includeColorQuery ? 'gone' : this.askerWait.judge(drain))
    } while (drain && this.askerWait.waiting)
    if (this.askerWait.waiting) {
      return
    }
    this.torn.releaseInSourceOrder(
      includeColorQuery || this.colorQueries.releasesTornCsi(this.torn.query.span?.data)
    )
  }

  /** `seen`: the owner already recorded these bytes' colour SETs while answering them in order. */
  private emit(span: PtyIngressSourceSpan, transformed: boolean, data = span.data, seen = false) {
    if (this.scope.kitty) {
      this.kittyModes.scan(data)
    }
    if (!seen) {
      this.colorQueries.observe(data)
    }
    this.onEmission({ data, rawStartSeq: span.rawStartSeq, rawEndSeq: span.rawEndSeq, transformed })
  }

  private clearDeadline(): void {
    clearTimeout(this.deadlineTimer ?? undefined)
    this.deadlineTimer = null
  }
}
