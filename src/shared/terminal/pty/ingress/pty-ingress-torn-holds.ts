import { PtyIngressHeldSpan } from './pty-ingress-held-span'
import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'

// Allow relay jitter before releasing torn echoes raw (#12112). Next reads/snapshot barriers usually end the wait;
// only one projection’s echo-shaped bytes on an idle pane are exposed to this guess.
const ECHO_CONTINUATION_HOLD_MS = 500

/** A torn query candidate and a torn reply echo, each held across reads until completed or timed out (then raw). */
export class PtyIngressTornHolds {
  // Why: a torn candidate that never completes must not withhold output indefinitely.
  readonly query: PtyIngressHeldSpan
  readonly echo: PtyIngressHeldSpan

  constructor(
    onExpire: (kind: 'release-query' | 'release-echo') => void,
    private readonly emitRaw: (span: PtyIngressSourceSpan) => void
  ) {
    this.query = new PtyIngressHeldSpan(ECHO_CONTINUATION_HOLD_MS, () => onExpire('release-query'))
    this.echo = new PtyIngressHeldSpan(ECHO_CONTINUATION_HOLD_MS, () => onExpire('release-echo'))
  }

  releaseQuery(): void {
    const pending = this.query.take()
    if (pending) {
      this.emitRaw(pending)
    }
  }

  /** Query before echo: it would own earlier bytes, though current classification never arms both. */
  releaseInSourceOrder(includeQuery: boolean): void {
    if (includeQuery) {
      this.releaseQuery()
    }
    const pending = this.echo.take()
    if (pending) {
      this.emitRaw(pending)
    }
  }
}
