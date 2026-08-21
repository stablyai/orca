import type { PtyOwnerBackend } from './pty-owner-backend'
import {
  isBetterEchoMatch,
  locateEcho,
  replyEchoProjections,
  type EchoProjection,
  type PtyStartupReplyEchoMatch
} from './pty-startup-reply-echo-shapes'

export type { PtyStartupReplyEchoMatch } from './pty-startup-reply-echo-shapes'

// Why this module exists: a reply is written to the PTY master, so whatever line
// discipline sits between Orca and the querying program can echo it straight back out as
// ordinary output (#12112). ConPTY echoes it with the ESC bytes stripped; a POSIX tty
// echoes it while the querying program is still cooked.
//
// The reply is written IMMEDIATELY, in the caller's turn. Orca used to withhold it until
// an ECHO probe proved the line discipline was quiet, and that withholding was the
// mistake: it made the write asynchronous, so a reply written later could overtake a held
// one and land in the next program's stdin (#15559). Delay never removed the echo either
// — the wait was bounded and always ended in a write — so the output-side projections
// below were always the load-bearing half. Now they are the only half, which also means
// replies leave in call order by construction, with no queue to reorder them.
//
// There are TWO echo sources and they are independent:
//
//   1. The kernel line discipline, when ECHO is set. Its ECHOCTL caret form is the POSIX
//      default; a `stty -echoctl` tty instead echoes the reply verbatim.
//   2. The foreground line editor, in software. readline echoes a master write as if it
//      were typed *while the tty is raw with ECHO off*, so no reading of the kernel's
//      ECHO bit can predict it. Verified on a live pty: at a bash prompt the kernel
//      reports quiet and readline still emits `BEL 10;rgb:2e2e/3434/3434`.
//
// Both are projected on every write, which is why (2) is covered at all.

type ExpectedEcho = { projections: readonly EchoProjection[]; remainingBytes: number }

// Why bytes and not reads: the echo is a fixed ~30 bytes, but nothing bounds how the tty
// chunks them — an SSH relay or a slow drain delivers a few bytes at a time, and a
// per-read budget is then spent inside the echo itself. This is a backstop against a
// pathological stream, set well above any splash an echo could arrive behind.
const ECHO_SEARCH_BUDGET_BYTES = 256 * 1024
// Why far tighter past the deadline: a reply still on the wire at expiry deserves the
// read or two its echo takes, but nothing beyond it — see reset().
const ECHO_POST_DEADLINE_BUDGET_BYTES = 512
// Live replies make the queue session-lived, so cap it under query floods.
const MAX_TRACKED_ECHOES = 64

/** Owns how a reply's own echo is recognized in the output that follows it. */
export class PtyStartupReplyDelivery {
  private readonly expectedEchoes: ExpectedEcho[] = []
  private closed = false

  constructor(
    private readonly ownerBackend: PtyOwnerBackend,
    private readonly writeProvider: (data: string) => void
  ) {}

  get hasExpectedEcho(): boolean {
    return this.expectedEchoes.length > 0
  }

  /**
   * Writes the reply now and arms its echo shapes. False means the write threw and
   * nothing was sent — the return value is the truth, because the write already happened
   * by the time it is returned.
   */
  answer(reply: string): boolean {
    if (this.closed) {
      return false
    }
    const projections = replyEchoProjections(reply, this.ownerBackend)
    // Why register before the write: node-pty can synchronously re-enter onData, so the
    // echo can arrive inside `writeProvider` itself.
    const expected: ExpectedEcho | null =
      projections.length > 0 ? { projections, remainingBytes: ECHO_SEARCH_BUDGET_BYTES } : null
    if (expected) {
      this.expectedEchoes.push(expected)
    }
    try {
      this.writeProvider(reply)
      if (this.expectedEchoes.length > MAX_TRACKED_ECHOES) {
        this.expectedEchoes.shift()
      }
      return true
    } catch {
      // Why splice by identity, not pop: the write above can re-enter onData and retire a
      // different projection, so the last slot is not necessarily ours.
      const index = expected ? this.expectedEchoes.indexOf(expected) : -1
      if (index !== -1) {
        this.expectedEchoes.splice(index, 1)
      }
      return false
    }
  }

  /** Recognizes any written reply's echo anywhere in the span, earliest match first. */
  matchEcho(data: string): PtyStartupReplyEchoMatch {
    let best: PtyStartupReplyEchoMatch = { kind: 'none' }
    let bestIndex = -1
    for (const [index, expected] of this.expectedEchoes.entries()) {
      const match = locateEcho(expected.projections, data)
      if (isBetterEchoMatch(match, best)) {
        best = match
        bestIndex = index
      }
    }
    if (best.kind === 'complete') {
      this.expectedEchoes.splice(bestIndex, 1)
      return best
    }
    return best
  }

  /**
   * Bytes that went by without completing an echo. Charged by the caller once per PTY
   * read rather than per `matchEcho` call, which runs several times over one span.
   */
  chargeEchoSearch(byteCount: number): void {
    for (let index = this.expectedEchoes.length - 1; index >= 0; index -= 1) {
      const expected = this.expectedEchoes[index]
      if (!expected) {
        continue
      }
      expected.remainingBytes -= byteCount
      if (expected.remainingBytes <= 0) {
        this.expectedEchoes.splice(index, 1)
      }
    }
  }

  /**
   * Startup window closed. Replies already on the wire stay recognizable, but only across
   * the next few hundred bytes: an unbounded projection would keep deleting matching
   * spans out of ordinary output for the rest of the session.
   */
  reset(): void {
    for (const expected of this.expectedEchoes) {
      expected.remainingBytes = Math.min(expected.remainingBytes, ECHO_POST_DEADLINE_BUDGET_BYTES)
    }
  }

  /** Teardown: nothing is in flight, because a reply is written as it is accepted. */
  close(): void {
    this.closed = true
    this.expectedEchoes.length = 0
  }
}
