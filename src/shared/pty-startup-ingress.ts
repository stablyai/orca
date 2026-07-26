import {
  parseTerminalOscColorQuery,
  terminalOscColorQueryReplies,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { PtyOwnerBackend } from './pty-owner-backend'
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

function projectedWindowsConptyReply(reply: string): string {
  // Why: the native provider harness observes ConPTY's cooked echo with ESC removed.
  return reply.replaceAll('\x1b', '')
}

/**
 * Serialized source-side startup classifier. Its raw sequence begins after
 * shell-ready preprocessing and every accepted range is emitted exactly once.
 */
export class PtyStartupIngress {
  private readonly intent: PtyStartupIngressIntent | undefined
  private readonly ownerBackend: PtyOwnerBackend
  private readonly writeProvider: (data: string) => void
  private readonly onEmission: (emission: PtyIngressEmission) => void
  private readonly operations: PtyStartupIngressOperation[] = []
  private readonly answeredSlots = new Set<TerminalOscColorQuerySlot>()
  private readonly expectedEchoes: string[] = []
  private processing = false
  private closed = false
  private queryOpen: boolean
  private rawHighWater = 0
  private queryPending: PtyIngressSourceSpan | null = null
  private echoPending: PtyIngressSourceSpan | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PtyStartupIngressOptions) {
    this.intent = options.intent
    this.ownerBackend = options.ownerBackend ?? 'posix-pty'
    this.writeProvider = options.write
    this.onEmission = options.onEmission
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
        if (this.ownerBackend !== 'windows-conpty') {
          this.queryOpen = false
          this.releaseQueryPending()
        }
        // Why: ConPTY cannot safely transfer color-query authority to a downstream view.
        return
      case 'expire':
        this.queryOpen = false
        this.releaseEchoPending()
        if (this.ownerBackend !== 'windows-conpty') {
          this.releaseQueryPending()
        }
        this.expectedEchoes.length = 0
        this.clearDeadline()
        return
      case 'snapshot':
        this.releaseSnapshotPending()
        return
      case 'teardown':
        this.queryOpen = false
        this.releaseAllPending()
        this.expectedEchoes.length = 0
        this.clearDeadline()
        this.closed = true
    }
  }

  private processEchoSpan(span: PtyIngressSourceSpan): void {
    let input = combinePtyIngressSourceSpans(this.echoPending, span)
    this.echoPending = null

    while (this.expectedEchoes.length > 0) {
      const expected = this.expectedEchoes[0]
      const compared = Math.min(input.data.length, expected.length)
      let matching = 0
      while (matching < compared && input.data[matching] === expected[matching]) {
        matching += 1
      }
      if (matching < compared) {
        this.expectedEchoes.shift()
        this.processQuerySpan(input)
        return
      }
      if (input.data.length < expected.length) {
        this.echoPending = input
        return
      }

      this.expectedEchoes.shift()
      this.emit(slicePtyIngressSourceSpan(input, 0, expected.length), true, '')
      input = slicePtyIngressSourceSpan(input, expected.length)
      if (input.data.length === 0) {
        return
      }
    }

    this.processQuerySpan(input)
  }

  private processQuerySpan(span: PtyIngressSourceSpan): void {
    const input = combinePtyIngressSourceSpans(this.queryPending, span)
    this.queryPending = null
    const suppressConptyQuery = this.ownerBackend === 'windows-conpty'
    if ((!this.queryOpen || !this.intent) && !suppressConptyQuery) {
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
      const answered = this.queryOpen && this.intent && this.answerQuery(query.slots)
      if (answered || suppressConptyQuery) {
        this.emit(querySpan, true, '')
      } else {
        this.emit(querySpan, false)
      }
      scanOffset = query.endIndex
      emittedOffset = query.endIndex
    }
  }

  private answerQuery(slots: readonly TerminalOscColorQuerySlot[]): boolean {
    if (slots.some((slot) => this.answeredSlots.has(slot)) || !this.intent) {
      return false
    }
    const replies = terminalOscColorQueryReplies(this.intent.colors, slots)
    if (!replies) {
      return false
    }

    let wroteAny = false
    for (const [index, reply] of replies.entries()) {
      const slot = slots[index]
      if (slot === undefined) {
        return wroteAny
      }
      this.answeredSlots.add(slot)
      const projected =
        this.ownerBackend === 'windows-conpty' ? projectedWindowsConptyReply(reply) : null
      if (projected) {
        // Why: register before write because node-pty can synchronously re-enter onData.
        this.expectedEchoes.push(projected)
      }
      try {
        this.writeProvider(reply)
        wroteAny = true
      } catch {
        this.answeredSlots.delete(slot)
        if (projected) {
          this.expectedEchoes.pop()
        }
        return wroteAny
      }
    }

    if (this.answeredSlots.has(10) && this.answeredSlots.has(11)) {
      this.queryOpen = false
    }
    return wroteAny
  }

  private releaseQueryPending(): void {
    if (!this.queryPending) {
      return
    }
    const pending = this.queryPending
    this.queryPending = null
    this.emit(pending, false)
  }

  private releaseAllPending(): void {
    this.releaseEchoPending()
    this.releaseQueryPending()
  }

  private releaseEchoPending(): void {
    if (!this.echoPending) {
      return
    }
    const pending = this.echoPending
    this.echoPending = null
    this.emit(pending, false)
  }

  private releaseSnapshotPending(): void {
    if (this.echoPending) {
      this.expectedEchoes.shift()
      this.releaseEchoPending()
    }
    if (this.ownerBackend !== 'windows-conpty') {
      this.releaseQueryPending()
    }
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
