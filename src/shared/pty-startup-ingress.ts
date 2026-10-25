import { nextQueryCandidate, parsePtyStartupQuery } from './pty-startup-query'
import { PtyOwnerColorQueryReplies } from './pty-owner-color-query-replies'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'
import type { TerminalOscColorQuerySlot } from './terminal-osc-color-reply'
import type { PtyOwnerBackend } from './pty-owner-backend'
import { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import { deliverTerminalQueryReplyPayload } from './terminal-query-reply-delivery'
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
// Allow relay jitter before releasing torn echoes raw (#12112). Next reads/snapshot barriers usually end the wait;
// only one projection’s echo-shaped bytes on an idle pane are exposed to this guess.
const ECHO_CONTINUATION_HOLD_MS = 500
// Why a default: every PTY has a startup window, because it bounds the long echo watch.
const DEFAULT_STARTUP_WINDOW_MS = 5_000

/** Serialize source classification after shell-ready preprocessing; emit each accepted range once. Own all lifetime OSC 10/11
 * queries here and strip them so viewers cannot answer twice. Only Kitty authority expires with startup. */
export class PtyStartupIngress {
  private readonly colorQueries: PtyOwnerColorQueryReplies
  private readonly ownerBackend: PtyOwnerBackend
  private readonly delivery: PtyStartupReplyDelivery
  private readonly onEmission: (emission: PtyIngressEmission) => void
  private readonly operations: PtyStartupIngressOperation[] = []
  private processing = false
  private closed = false
  private kittyQueryOpen: boolean
  private readonly kittyModes = new TerminalKittyKeyboardModeTracker()
  private rawHighWater = 0
  private queryPending: PtyIngressSourceSpan | null = null
  private echoPending: PtyIngressSourceSpan | null = null
  private echoHoldTimer: ReturnType<typeof setTimeout> | null = null
  private queryHoldTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PtyStartupIngressOptions) {
    this.colorQueries = new PtyOwnerColorQueryReplies(options.intent, options.resolveHostColors)
    this.ownerBackend = options.ownerBackend ?? 'posix-pty'
    this.delivery = new PtyStartupReplyDelivery(
      this.ownerBackend,
      options.write,
      Date.now() + (options.intent?.deadlineMs ?? DEFAULT_STARTUP_WINDOW_MS)
    )
    this.onEmission = options.onEmission
    this.kittyQueryOpen = options.intent?.kittyKeyboardProtocol === true
    if (options.intent && this.kittyQueryOpen) {
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
        this.processEchoSpan(operation.chunk)
        return
      case 'close-query':
        // Only Kitty authority closes; lifetime color replies and already-written echoes remain owner responsibilities.
        this.kittyQueryOpen = false
        if (this.queryPending?.data.startsWith('\x1b[')) {
          this.releaseQueryPending()
        }
        return
      case 'expire':
        this.kittyQueryOpen = false
        this.releasePendingInSourceOrder(false)
        this.clearDeadline()
        return
      case 'snapshot':
      case 'release-echo':
        this.releasePendingInSourceOrder(false)
        return
      case 'release-query':
        this.releaseQueryPending()
        return
      case 'teardown':
        this.kittyQueryOpen = false
        this.releasePendingInSourceOrder(true)
        this.delivery.close()
        this.clearDeadline()
        this.clearQueryHold()
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
    let input = combinePtyIngressSourceSpans(this.takeEchoPending(), span)

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
          if (this.queryPending) {
            const resolved = combinePtyIngressSourceSpans(this.queryPending, tail)
            if (parsePtyStartupQuery(resolved.data, 0, this.kittyQueryOpen).kind !== 'none') {
              this.processQuerySpan(tail)
              return
            }
            // Unlike ordinary ConPTY barrier release, combined candidate+tail is now disproven as a query; release it unconditionally.
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
      // Release torn candidates before suppressed ranges so raw sequence accounting stays aligned.
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
    this.clearQueryHold()
    const suppressConptyQuery = this.ownerBackend === 'windows-conpty'

    let scanOffset = 0
    let emittedOffset = 0
    while (scanOffset < input.data.length) {
      const candidateIndex = nextQueryCandidate(input.data, scanOffset, this.kittyQueryOpen)
      if (candidateIndex === -1) {
        this.emit(slicePtyIngressSourceSpan(input, emittedOffset), false)
        return
      }
      const query = parsePtyStartupQuery(input.data, candidateIndex, this.kittyQueryOpen)
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
          this.armQueryHold()
        } else {
          this.emit(candidate, false)
        }
        return
      }

      if (candidateIndex > emittedOffset) {
        this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
      }
      const querySpan = slicePtyIngressSourceSpan(input, candidateIndex, query.endIndex)
      const answered =
        query.kind === 'kitty'
          ? this.delivery.answer(`\x1b[?${this.kittyModes.flags}u`, 'owner')
          : this.answerColorQuery(query.slots)
      if (query.kind === 'kitty' && answered) {
        this.kittyQueryOpen = false
      }
      // A failed write passes the query on, except under ConPTY, whose ESC-stripped
      // echo of a downstream reply would leak into a cooked shell (#9651).
      if (answered || (suppressConptyQuery && query.kind !== 'kitty')) {
        this.emit(querySpan, true, '')
      } else {
        this.emit(querySpan, false)
      }
      scanOffset = query.endIndex
      emittedOffset = query.endIndex
    }
  }

  /** True when at least the first reply landed; a failed write stops the rest in order. */
  private answerColorQuery(slots: readonly TerminalOscColorQuerySlot[]): boolean {
    const replies = this.colorQueries.replies(slots)
    return (
      replies.length > 0 &&
      replies.findIndex((reply) => !this.delivery.answer(reply, 'owner')) !== 0
    )
  }

  private releaseQueryPending(): void {
    const pending = this.queryPending
    this.queryPending = null
    this.clearQueryHold()
    if (pending) {
      this.emit(pending, false)
    }
  }

  /** Release query before echo defensively: it would own earlier bytes, though current classification never arms both.
   * Retain torn colors across barriers unless explicitly included: viewers lack reply authority, so only hold timeout/teardown ends them. */
  private releasePendingInSourceOrder(includeColorQuery: boolean): void {
    if (includeColorQuery || this.queryPending?.data.startsWith('\x1b[')) {
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

  /** Why: a torn candidate that never completes must not withhold output indefinitely. */
  private armQueryHold(): void {
    this.queryHoldTimer ??= setTimeout(
      () => this.enqueue({ kind: 'release-query' }),
      ECHO_CONTINUATION_HOLD_MS
    )
    this.queryHoldTimer.unref?.()
  }

  private clearQueryHold(): void {
    clearTimeout(this.queryHoldTimer ?? undefined)
    this.queryHoldTimer = null
  }

  private emit(span: PtyIngressSourceSpan, transformed: boolean, data = span.data): void {
    if (this.kittyQueryOpen) {
      this.kittyModes.scan(data)
    }
    this.colorQueries.observe(data)
    this.onEmission({ data, rawStartSeq: span.rawStartSeq, rawEndSeq: span.rawEndSeq, transformed })
  }

  private clearDeadline(): void {
    clearTimeout(this.deadlineTimer ?? undefined)
    this.deadlineTimer = null
  }
}
