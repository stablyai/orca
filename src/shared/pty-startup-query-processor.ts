import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { PtyOwnerBackend } from './pty-owner-backend'
import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import {
  parseTerminalKittyKeyboardQuery,
  terminalKittyKeyboardStatusReply
} from './terminal-kitty-keyboard-query'
import {
  parseTerminalOscColorQuery,
  terminalOscColorQueryReplies,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import {
  combinePtyIngressSourceSpans,
  slicePtyIngressSourceSpan,
  type PtyIngressEmission,
  type PtyIngressSourceSpan
} from './pty-startup-ingress-contract'

const MAX_QUERY_CANDIDATE_CHARS = 64

export class PtyStartupQueryProcessor {
  private readonly answeredSlots = new Set<TerminalOscColorQuerySlot>()
  private answeredKittyKeyboardQuery = false
  private queryOpen: boolean
  private queryPending: PtyIngressSourceSpan | null = null

  constructor(
    private readonly options: {
      intent: PtyStartupIngressIntent | undefined
      ownerBackend: PtyOwnerBackend
      delivery: PtyStartupReplyDelivery
      onEmission: (emission: PtyIngressEmission) => void
    }
  ) {
    this.queryOpen = options.intent !== undefined
  }

  get hasPendingQuery(): boolean {
    return this.queryPending !== null
  }

  accept(span: PtyIngressSourceSpan): void {
    const input = combinePtyIngressSourceSpans(this.queryPending, span)
    this.queryPending = null
    const suppressConptyQuery = this.options.ownerBackend === 'windows-conpty'
    if ((!this.queryOpen || !this.options.intent) && !suppressConptyQuery) {
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
      const colorQuery = parseTerminalOscColorQuery(input.data, candidateIndex)
      if (colorQuery.kind === 'match') {
        if (candidateIndex > emittedOffset) {
          this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
        }
        const querySpan = slicePtyIngressSourceSpan(input, candidateIndex, colorQuery.endIndex)
        const answered = this.queryOpen && this.answerColorQuery(colorQuery.slots)
        this.emit(
          querySpan,
          answered || suppressConptyQuery,
          answered || suppressConptyQuery ? '' : querySpan.data
        )
        scanOffset = colorQuery.endIndex
        emittedOffset = colorQuery.endIndex
        continue
      }
      if (colorQuery.kind === 'partial') {
        this.holdPartialQuery(input, candidateIndex, emittedOffset)
        return
      }

      const kittyQuery = this.canAnswerKittyKeyboardQuery()
        ? parseTerminalKittyKeyboardQuery(input.data, candidateIndex)
        : { kind: 'none' as const }
      if (kittyQuery.kind === 'complete') {
        if (candidateIndex > emittedOffset) {
          this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
        }
        const querySpan = slicePtyIngressSourceSpan(input, candidateIndex, kittyQuery.endIndex)
        const answered = this.answerKittyKeyboardQuery()
        this.emit(querySpan, answered, answered ? '' : querySpan.data)
        scanOffset = kittyQuery.endIndex
        emittedOffset = kittyQuery.endIndex
        continue
      }
      if (kittyQuery.kind === 'partial') {
        this.holdPartialQuery(input, candidateIndex, emittedOffset)
        return
      }
      scanOffset = candidateIndex + 1
    }
  }

  closeQueryAuthority(): void {
    this.queryOpen = false
    this.releasePending()
  }

  expire(): void {
    this.queryOpen = false
  }

  releasePending(): void {
    const pending = this.queryPending
    this.queryPending = null
    if (pending) {
      this.emit(pending, false)
    }
  }

  isPendingCandidateWith(span: PtyIngressSourceSpan): boolean {
    const pending = this.queryPending
    return pending ? this.isQueryCandidate(combinePtyIngressSourceSpans(pending, span).data) : false
  }

  private holdPartialQuery(
    input: PtyIngressSourceSpan,
    candidateIndex: number,
    emittedOffset: number
  ): void {
    if (candidateIndex > emittedOffset) {
      this.emit(slicePtyIngressSourceSpan(input, emittedOffset, candidateIndex), false)
    }
    const candidate = slicePtyIngressSourceSpan(input, candidateIndex)
    if (candidate.data.length <= MAX_QUERY_CANDIDATE_CHARS) {
      this.queryPending = candidate
    } else {
      this.emit(candidate, false)
    }
  }

  private answerColorQuery(slots: readonly TerminalOscColorQuerySlot[]): boolean {
    const intent = this.options.intent
    if (slots.some((slot) => this.answeredSlots.has(slot)) || !intent?.colors) {
      return false
    }
    const replies = terminalOscColorQueryReplies(intent.colors, slots)
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
      if (!this.options.delivery.answer(reply)) {
        this.answeredSlots.delete(slot)
        return wroteAny
      }
      wroteAny = true
    }
    if (
      this.answeredSlots.has(10) &&
      this.answeredSlots.has(11) &&
      !intent.kittyKeyboardAdvertised
    ) {
      this.queryOpen = false
    }
    return wroteAny
  }

  private answerKittyKeyboardQuery(): boolean {
    if (this.answeredKittyKeyboardQuery || !this.canAnswerKittyKeyboardQuery()) {
      return false
    }
    if (!this.options.delivery.answer(terminalKittyKeyboardStatusReply)) {
      return false
    }
    this.answeredKittyKeyboardQuery = true
    return true
  }

  private canAnswerKittyKeyboardQuery(): boolean {
    return this.queryOpen && this.options.intent?.kittyKeyboardAdvertised === true
  }

  private isQueryCandidate(data: string): boolean {
    return (
      parseTerminalOscColorQuery(data, 0).kind !== 'none' ||
      (this.canAnswerKittyKeyboardQuery() &&
        parseTerminalKittyKeyboardQuery(data, 0).kind !== 'none')
    )
  }

  private emit(span: PtyIngressSourceSpan, transformed: boolean, data = span.data): void {
    this.options.onEmission({
      data,
      rawStartSeq: span.rawStartSeq,
      rawEndSeq: span.rawEndSeq,
      transformed
    })
  }
}
