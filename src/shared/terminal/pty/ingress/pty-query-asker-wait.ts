import { PtyIngressHeldSpan } from './pty-ingress-held-span'
import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'
import {
  lastCommandFinishEnd,
  PtyQueryAskerPresence,
  type PtyQueryAskerSample,
  type PtyQueryAskerVerdict
} from './pty-query-asker-presence'

// Why: a shell prints 133;D about 1 ms after an asker exits; Codex, the strictest live asker, waits 100 ms.
const ASKER_WAIT_MS = 20

/** Holds a colour query and every byte after it until its asker is known, so a DA1 sentinel never overtakes the reply. */
export class PtyQueryAskerWait {
  private readonly presence: PtyQueryAskerPresence
  private readonly query: PtyIngressHeldSpan
  private later: PtyIngressSourceSpan[] = []
  private verdict: { untilSeq: number; presence: PtyQueryAskerVerdict } | null = null
  private finishEnd: { input: string; end: number } | undefined
  // Why: every query held before the command's finish marker shares its verdict, so replay never re-holds them.
  private finishSeq = -1

  constructor(
    readForegroundGroup: (() => number | null | undefined) | undefined,
    onExpire: () => void
  ) {
    this.presence = new PtyQueryAskerPresence(readForegroundGroup)
    this.query = new PtyIngressHeldSpan(ASKER_WAIT_MS, onExpire)
  }

  get waiting(): boolean {
    return this.query.span !== null
  }

  noteMarker(payload: string, adjacent: boolean): void {
    this.presence.noteMarker(payload, adjacent)
  }

  /** A held query's verdict, else what the stream says now; `input` is the read holding the query. */
  sampleAt(query: PtyIngressSourceSpan, input: string, queryEnd: number): PtyQueryAskerSample {
    if (this.verdict && query.rawStartSeq < this.verdict.untilSeq) {
      return { presence: this.verdict.presence }
    }
    return this.presence.sample(() => {
      // Why: one marker scan per read, however many queries it holds.
      if (this.finishEnd?.input !== input) {
        this.finishEnd = { input, end: lastCommandFinishEnd(input) }
      }
      return this.finishEnd.end > queryEnd
    })
  }

  /** `from`: the query (`queryLength` chars) and the rest of its read; `group` holds the terminal now. */
  hold(from: PtyIngressSourceSpan, group: number | null, queryLength: number): void {
    this.query.hold(from)
    this.presence.hold(from.data.slice(queryLength), group)
  }

  /** A later read while waiting: the verdict once that read settles it. */
  review(read: PtyIngressSourceSpan): PtyQueryAskerVerdict | null {
    this.later.push(read)
    const end = this.presence.watch(read.data)
    if (end >= 0 && this.finishSeq < 0) {
      this.finishSeq = read.rawStartSeq + end
    }
    return this.presence.judge(false)
  }

  /** `gone` once proven; otherwise `present` when `final` (expiry), else null to keep holding. */
  judge(final: boolean): PtyQueryAskerVerdict | null {
    return this.waiting ? this.presence.judge(final) : null
  }

  /** Ends the wait; queries in the held span take `verdict`, and later reads are classified afresh. */
  settle(
    verdict: PtyQueryAskerVerdict
  ): { from: PtyIngressSourceSpan; later: PtyIngressSourceSpan[] } | null {
    const from = this.query.take()
    const later = this.later
    this.later = []
    const finishSeq = this.finishSeq
    this.finishSeq = -1
    this.presence.release(verdict)
    if (!from) {
      return null
    }
    const untilSeq = verdict === 'gone' ? Math.max(from.rawEndSeq, finishSeq) : from.rawEndSeq
    this.verdict = { untilSeq, presence: verdict }
    return { from, later }
  }
}
