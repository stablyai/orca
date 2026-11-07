/* eslint-disable max-lines -- Why: classification, echo suppression and the colour-reply hold share one ordered operation queue; splitting them would split the ordering invariant. */
import { nextQueryCandidate, parsePtyStartupQuery } from './pty-startup-query'
import { PtyOwnerColorQueryReplies } from './pty-owner-color-query-replies'
import { TerminalKittyKeyboardModeTracker } from '../../protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import type { PtyOwnerBackend } from '../lifecycle/pty-owner-backend'
import { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import { PtyQueryAskerWait } from './pty-query-asker-wait'
import type { PtyQueryAskerVerdict } from './pty-query-asker-presence'
import { PtyIngressHeldSpan } from './pty-ingress-held-span'
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

// Allow relay jitter before releasing torn echoes raw (#12112). Next reads/snapshot barriers usually end the wait;
// only one projection’s echo-shaped bytes on an idle pane are exposed to this guess.
const ECHO_CONTINUATION_HOLD_MS = 500
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
  // Why: a torn candidate that never completes must not withhold output indefinitely.
  private readonly tornQuery = new PtyIngressHeldSpan(ECHO_CONTINUATION_HOLD_MS, () =>
    this.enqueue({ kind: 'release-query' })
  )
  private readonly tornEcho = new PtyIngressHeldSpan(ECHO_CONTINUATION_HOLD_MS, () =>
    this.enqueue({ kind: 'release-echo' })
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
          this.releaseQueryPending()
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
        if (this.colorQueries.releasesTornCsi(this.tornQuery.span?.data)) {
          this.releaseQueryPending()
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
        this.releaseQueryPending()
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
    let input = combinePtyIngressSourceSpans(this.tornEcho.take(), span)

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
          if (this.tornQuery.span) {
            const resolved = combinePtyIngressSourceSpans(this.tornQuery.span, tail)
            if (parsePtyStartupQuery(resolved.data, 0, this.scope).kind !== 'none') {
              this.processQuerySpan(tail)
              return
            }
            // Unlike ordinary ConPTY barrier release, combined candidate+tail is now disproven as a query; release it unconditionally.
            this.releaseQueryPending()
          }
          this.tornEcho.hold(tail)
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
      this.releaseQueryPending()
      this.emit(echo, true, '')
      input = slicePtyIngressSourceSpan(input, echoEnd)
    }

    if (input.data.length > 0) {
      this.processQuerySpan(input)
    }
  }

  /** A colour query whose asker may be exiting holds the rest of the span; callers defer what follows. */
  private processQuerySpan(span: PtyIngressSourceSpan): void {
    const input = combinePtyIngressSourceSpans(this.tornQuery.take(), span)
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
          this.tornQuery.hold(candidate)
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

  private releaseQueryPending(): void {
    const pending = this.tornQuery.take()
    if (pending) {
      this.emit(pending, false)
    }
  }

  /** Settle held askers first: a barrier ends only a wait proven gone; teardown and a final snapshot drop them.
   * Anything still behind a held asker stays held. Release query before echo defensively: it would own earlier bytes, though current classification never arms both.
   * Retain torn colors across barriers unless explicitly included: viewers lack reply authority, so only hold timeout/teardown ends them. */
  private releasePendingInSourceOrder(includeColorQuery: boolean, drain = includeColorQuery): void {
    do {
      this.settleAskerWait(includeColorQuery || drain ? 'gone' : this.askerWait.judge(false))
    } while (drain && this.askerWait.waiting)
    if (this.askerWait.waiting) {
      return
    }
    if (includeColorQuery || this.colorQueries.releasesTornCsi(this.tornQuery.span?.data)) {
      this.releaseQueryPending()
    }
    const pending = this.tornEcho.take()
    if (pending) {
      this.emit(pending, false)
    }
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
