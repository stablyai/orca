import type { PtyOwnerBackend } from './pty-owner-backend'
import {
  isBetterEchoMatch,
  locateEcho,
  replyEchoProjections,
  type EchoProjection,
  type PtyStartupReplyEchoMatch
} from './pty-startup-reply-echo-shapes'

export type { PtyStartupReplyEchoMatch } from './pty-startup-reply-echo-shapes'

// Master writes echo through ConPTY ESC-stripping, cooked kernel line discipline or raw readline software (#12112).
// Write synchronously in call order: waiting for ECHO-clear reordered replies into later programs’ stdin (#15559) without removing echoes.
// Always arm both kernel (ECHOCTL or verbatim) and software readline projections; ECHO-clear cannot predict readline echoes.

/** `owner`: a reply this PTY's owner produced itself; `relayed`: one a viewer sent in. */
export type PtyReplySource = 'owner' | 'relayed'

type ExpectedEcho = {
  projections: readonly EchoProjection[]
  remainingBytes: number
  source: PtyReplySource
}

// Charge bytes, not reads: SSH/slow drains split fixed-length echoes arbitrarily. Allow large startup splashes before expiry.
const ECHO_SEARCH_BUDGET_BYTES = 256 * 1024
// Late owner replies follow synchronous queries without splash output; relayed replies can trail ongoing app output and need longer watches.
const ECHO_POST_STARTUP_BUDGET_BYTES = 512
// Live replies make the queue session-lived, so cap it under query floods.
const MAX_TRACKED_ECHOES = 64

/** Owns how a reply's own echo is recognized in the output that follows it. */
export class PtyStartupReplyDelivery {
  private readonly expectedEchoes: ExpectedEcho[] = []
  private closed = false
  private startupWindowOpen = true

  /** Why a clock and not a timer: a timer per PTY for the whole session would outlive its use. */
  constructor(
    private readonly ownerBackend: PtyOwnerBackend,
    private readonly writeProvider: (data: string) => void,
    private readonly startupWindowEndsAt: number
  ) {}

  get hasExpectedEcho(): boolean {
    return this.expectedEchoes.length > 0
  }

  /** Write and arm echo shapes now; false means the write threw, so the return value reflects completed synchronous work. */
  answer(reply: string, source: PtyReplySource = 'relayed'): boolean {
    if (this.closed) {
      return false
    }
    this.endStartupWindowIfDue()
    const projections = replyEchoProjections(reply, this.ownerBackend)
    const remainingBytes =
      source === 'owner' && !this.startupWindowOpen
        ? ECHO_POST_STARTUP_BUDGET_BYTES
        : ECHO_SEARCH_BUDGET_BYTES
    // Arm before writeProvider: node-pty may synchronously reenter onData with the echo.
    const expected: ExpectedEcho | null =
      projections.length > 0 ? { projections, remainingBytes, source } : null
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
      // Reentrant onData may retire another projection; remove ours by identity instead of popping the last slot.
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

  /** Charge unmatched bytes once per PTY read, never per repeated matchEcho call over the same span. */
  chargeEchoSearch(byteCount: number): void {
    this.endStartupWindowIfDue()
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

  /** Startup window closed: the owner's own replies are watched for a short span only. */
  private endStartupWindowIfDue(): void {
    if (!this.startupWindowOpen || Date.now() < this.startupWindowEndsAt) {
      return
    }
    this.startupWindowOpen = false
    for (const expected of this.expectedEchoes) {
      if (expected.source === 'owner') {
        expected.remainingBytes = Math.min(expected.remainingBytes, ECHO_POST_STARTUP_BUDGET_BYTES)
      }
    }
  }

  /** Teardown: nothing is in flight, because a reply is written as it is accepted. */
  close(): void {
    this.closed = true
    this.expectedEchoes.length = 0
  }
}
