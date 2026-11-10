import { PtyIngressHeldSpan } from './pty-ingress-held-span'
import {
  slicePtyIngressSourceSpan,
  type PtyForegroundGroupReader,
  type PtyIngressSourceSpan,
  type PtyStartupIngressOperation
} from './pty-startup-ingress-contract'
import {
  lastCommandFinishEnd,
  PtyQueryAskerPresence,
  type PtyQueryAskerVerdict
} from './pty-query-asker-presence'

// Why: a shell prints 133;D about 1 ms after an asker exits; Codex, the strictest live asker, waits 100 ms.
const ASKER_WAIT_MS = 20

export type PtyIngressDeferredRead = Extract<PtyStartupIngressOperation, { kind: 'data' | 'echo' }>

/** Holds a colour query and every byte after it until its asker is known, so a DA1 sentinel never overtakes the reply. */
export class PtyQueryAskerWait {
  private readonly presence: PtyQueryAskerPresence
  private readonly query: PtyIngressHeldSpan
  private later: PtyIngressDeferredRead[] = []
  private verdict: { untilSeq: number; presence: PtyQueryAskerVerdict } | null = null
  // Why: queries held behind the first one share its verdict, so replay never re-holds them one by one.
  private finishSeq = -1
  private reviewedEndSeq = -1
  // Keyed by raw range, not the string, so a large read is not retained after its queries are decided.
  private finishEnd: { startSeq: number; endSeq: number; end: number } | null = null

  constructor(readForegroundGroup: PtyForegroundGroupReader | undefined, onExpire: () => void) {
    this.presence = new PtyQueryAskerPresence(readForegroundGroup)
    this.query = new PtyIngressHeldSpan(ASKER_WAIT_MS, onExpire)
  }

  get waiting(): boolean {
    return this.query.span !== null
  }

  noteMarker(payload: string, adjacent: boolean): void {
    this.presence.noteMarker(payload, adjacent)
  }

  /** The verdict for the colour query at [start, end) of `input`, or `held` once it and the rest of `input` wait. */
  consider(input: PtyIngressSourceSpan, start: number, end: number): PtyQueryAskerVerdict | 'held' {
    // Only a query wholly inside the covered reads takes the verdict; one completed later is judged afresh.
    if (this.verdict && input.rawStartSeq + end <= this.verdict.untilSeq) {
      return this.verdict.presence
    }
    const sample = this.presence.sample(() => this.lastFinishEndOf(input) > end)
    if (sample.presence !== 'unsure') {
      return sample.presence
    }
    this.query.hold(slicePtyIngressSourceSpan(input, start))
    this.presence.hold(input.data.slice(end), sample.group)
    return 'held'
  }

  /** A later read while waiting: the verdict once that read settles it. */
  review(read: PtyIngressDeferredRead): PtyQueryAskerVerdict | null {
    this.later.push(read)
    const end = this.presence.watch(read.chunk.data)
    if (end >= 0 && this.finishSeq < 0) {
      this.finishSeq = read.chunk.rawStartSeq + end
    }
    const verdict = this.presence.judge(false)
    if (verdict === null) {
      this.reviewedEndSeq = read.chunk.rawEndSeq
    }
    return verdict
  }

  /** `gone` once proven; otherwise `present` when `final` (expiry), else null to keep holding. */
  judge(final: boolean): PtyQueryAskerVerdict | null {
    return this.waiting ? this.presence.judge(final) : null
  }

  /** One finish-marker scan per read, however many queries it holds. */
  private lastFinishEndOf(input: PtyIngressSourceSpan): number {
    const cached = this.finishEnd
    const finishEnd =
      cached?.startSeq === input.rawStartSeq && cached.endSeq === input.rawEndSeq
        ? cached
        : {
            startSeq: input.rawStartSeq,
            endSeq: input.rawEndSeq,
            end: lastCommandFinishEnd(input.data)
          }
    this.finishEnd = finishEnd
    return finishEnd.end
  }

  /** Ends the wait; queries in the held span take `verdict`, and later reads are classified afresh. */
  settle(
    verdict: PtyQueryAskerVerdict
  ): { from: PtyIngressSourceSpan; later: PtyIngressDeferredRead[] } | null {
    const from = this.query.take()
    const later = this.later
    this.later = []
    // A finish marker bounds the asker's output; otherwise it covers every read seen before the verdict changed (the
    // read that showed another group is judged afresh: its bytes may already be the next program's).
    const coveredSeq = this.finishSeq >= 0 ? this.finishSeq : this.reviewedEndSeq
    this.finishSeq = -1
    this.reviewedEndSeq = -1
    this.presence.release()
    if (!from) {
      return null
    }
    this.verdict = { untilSeq: Math.max(from.rawEndSeq, coveredSeq), presence: verdict }
    return { from, later }
  }
}
