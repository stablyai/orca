import {
  parseTerminalOscColorQuery,
  terminalOscColorQueryReplies,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'

export {
  PTY_STARTUP_INGRESS_VERSION,
  parsePtyStartupIngressIntent
} from './pty-startup-ingress-intent'
export type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'

export type PtyIngressEmission = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
  transformed: boolean
}

type PtyIngressSourceChunk = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
}

type PendingOperation =
  | { kind: 'data'; chunk: PtyIngressSourceChunk }
  | { kind: 'close-query' }
  | { kind: 'snapshot' }
  | { kind: 'teardown' }
  | { kind: 'expire' }

type PendingSpan = PtyIngressSourceChunk

export type PtyStartupIngressOptions = {
  intent?: PtyStartupIngressIntent
  write: (data: string) => void
  onEmission: (emission: PtyIngressEmission) => void
}

const MAX_QUERY_CANDIDATE_CHARS = 64

function spanSlice(span: PendingSpan, start: number, end = span.data.length): PendingSpan {
  return {
    data: span.data.slice(start, end),
    rawStartSeq: span.rawStartSeq + start,
    rawEndSeq: span.rawStartSeq + end
  }
}

function combineSpans(first: PendingSpan | null, second: PendingSpan): PendingSpan {
  if (!first) {
    return second
  }
  return {
    data: first.data + second.data,
    rawStartSeq: first.rawStartSeq,
    rawEndSeq: second.rawEndSeq
  }
}

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
  private readonly writeProvider: (data: string) => void
  private readonly onEmission: (emission: PtyIngressEmission) => void
  private readonly operations: PendingOperation[] = []
  private readonly answeredSlots = new Set<TerminalOscColorQuerySlot>()
  private readonly expectedEchoes: string[] = []
  private processing = false
  private closed = false
  private queryOpen: boolean
  private rawHighWater = 0
  private queryPending: PendingSpan | null = null
  private echoPending: PendingSpan | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PtyStartupIngressOptions) {
    this.intent = options.intent
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

  private enqueue(operation: PendingOperation): void {
    if (this.closed) {
      return
    }
    this.operations.push(operation)
    if (this.processing) {
      return
    }
    this.processing = true
    try {
      let next: PendingOperation | undefined
      while ((next = this.operations.shift())) {
        this.applyOperation(next)
      }
    } finally {
      this.processing = false
    }
  }

  private applyOperation(operation: PendingOperation): void {
    switch (operation.kind) {
      case 'data':
        this.processEchoSpan(operation.chunk)
        return
      case 'close-query':
        this.queryOpen = false
        this.releaseQueryPending()
        return
      case 'expire':
        this.queryOpen = false
        this.releaseAllPending()
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

  private processEchoSpan(span: PendingSpan): void {
    let input = combineSpans(this.echoPending, span)
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
      this.emit(spanSlice(input, 0, expected.length), true, '')
      input = spanSlice(input, expected.length)
      if (input.data.length === 0) {
        return
      }
    }

    this.processQuerySpan(input)
  }

  private processQuerySpan(span: PendingSpan): void {
    const input = combineSpans(this.queryPending, span)
    this.queryPending = null
    if (!this.queryOpen || !this.intent) {
      this.emit(input, false)
      return
    }

    let offset = 0
    while (offset < input.data.length) {
      const candidateIndex = input.data.indexOf('\x1b', offset)
      if (candidateIndex === -1) {
        this.emit(spanSlice(input, offset), false)
        return
      }
      if (candidateIndex > offset) {
        this.emit(spanSlice(input, offset, candidateIndex), false)
      }
      const query = parseTerminalOscColorQuery(input.data, candidateIndex)
      if (query.kind === 'none') {
        this.emit(spanSlice(input, candidateIndex, candidateIndex + 1), false)
        offset = candidateIndex + 1
        continue
      }
      if (query.kind === 'partial') {
        const candidate = spanSlice(input, candidateIndex)
        if (candidate.data.length <= MAX_QUERY_CANDIDATE_CHARS) {
          this.queryPending = candidate
        } else {
          this.emit(candidate, false)
        }
        return
      }

      const querySpan = spanSlice(input, candidateIndex, query.endIndex)
      if (!this.answerQuery(query.slots)) {
        this.emit(querySpan, false)
      } else {
        this.emit(querySpan, true, '')
      }
      offset = query.endIndex
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
        this.intent.echoProjection === 'windows-conpty-esc-stripped'
          ? projectedWindowsConptyReply(reply)
          : null
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
    const pending = this.echoPending ?? this.queryPending
    this.echoPending = null
    this.queryPending = null
    if (pending) {
      this.emit(pending, false)
    }
  }

  private releaseSnapshotPending(): void {
    if (this.echoPending) {
      const pending = this.echoPending
      this.echoPending = null
      this.expectedEchoes.shift()
      this.emit(pending, false)
    }
    this.releaseQueryPending()
  }

  private emit(span: PendingSpan, transformed: boolean, data = span.data): void {
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
