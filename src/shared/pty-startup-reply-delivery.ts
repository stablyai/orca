import type { PtyOwnerBackend } from './pty-owner-backend'
import type { PtySlaveEchoProbe } from './pty-slave-line-discipline-echo'

// Why this module exists: a startup color reply is written to the PTY master, so
// whatever line discipline sits between Orca and the querying program can echo it
// straight back out as ordinary output (#12112). ConPTY echoes it with the ESC
// bytes stripped; a POSIX tty echoes it while the querying program is still cooked.
// A program that queries before clearing ECHO loses that race if Orca answers
// inside the query's own turn, so on POSIX the write waits until the slave's ECHO
// bit is observably clear, and recognized echo shapes cover what remains.
//
// Deliberately NO re-send on a matched echo: ECHO copies bytes to the master
// without consuming them from the slave's input queue, so a program that arms raw
// mode with TCSANOW/TCSADRAIN (libuv's setRawMode, hence Node-based agents) still
// receives the reply, and re-writing would duplicate it in stdin. A TCSAFLUSH
// switcher does discard it; that case is left to the query timeout, because a
// duplicate reply corrupts a parser that is already mid-read.
//
// Why not PostReadyFlushGate's settle-and-fallback shape, which solves this same
// "don't write while ECHO is on" race for shell startup input: that gate defers
// bytes nothing is waiting on, so it can wait for the stream to go observably
// quiet. A color reply is different — the querying program is blocked on it and
// times out — so the wait here is bounded by a budget and always ends in a write.
//
// There are TWO echo sources and they are independent, which is the thing to hold onto
// when reading the rest of this file:
//
//   1. The kernel line discipline, when ECHO is set. Readable state — the probe asks
//      the slave directly, and waiting for it to clear removes this echo outright.
//   2. The foreground line editor, in software. readline echoes a master write as if
//      it were typed *while the tty is raw with ECHO off*, so the probe's verdict says
//      nothing about it. Verified on a live pty: at a bash prompt the probe reports
//      `quiet` and readline still emits `BEL 10;rgb:2e2e/3434/3434`.
//
// So `quiet` is proof about (1) only. It gates the withholding and retires the caret
// projection, and must never be read as "no suppression needed" — that reintroduces
// #12112 at a shell prompt, which is the foreground for most of an agent pane's
// startup window. The projections below stay armed for (2) on every path.

export type PtyStartupReplyEchoMatch =
  | { kind: 'complete'; offset: number; length: number }
  | { kind: 'partial'; offset: number }
  | { kind: 'none' }

// Why bytes and not reads: the echo is a fixed ~30 bytes, but nothing bounds how the
// tty chunks them — an SSH relay or a slow drain delivers a few bytes at a time, and a
// per-read budget is then spent inside the echo itself. What actually bounds a live
// projection is the startup deadline; this is only a backstop against a pathological
// pre-deadline stream, so it is set well above any splash an echo could arrive behind.
const ECHO_SEARCH_BUDGET_BYTES = 256 * 1024
// Why far tighter past the deadline: a reply still on the wire at expiry deserves the
// read or two its echo takes, but nothing beyond it — see reset().
const ECHO_POST_DEADLINE_BUDGET_BYTES = 512
// Why this tight: the querying program is blocked on the reply, so every interval is
// latency it pays. A raw-mode switch lands within a turn or two of the query, and the
// probe is a subprocess — this is the smallest interval that does not spin on it.
const ECHO_POLL_INTERVAL_MS = 20
// Why a budget at all: the startup deadline runs to 30s, which at this interval is a
// four-figure count of probe subprocesses. It is also the wrong bound — a tty still
// cooked this long after its own query never leaves cooked mode, and waiting on it only
// delays a reply that will echo whenever it is sent.
//
// Why wall-clock rather than a probe count: each probe is a subprocess, so a multi-pane
// restore serializes them on fork — a count-based cap measured ~26ms per probe across
// 30 panes, turning a nominal 200ms into ~8s of withholding and blowing past every
// query timeout at once. A deadline spends fewer probes under load instead of taking
// longer, which is the direction that fails safe: measured flat at ~210ms of withholding
// from 1 to 100 concurrent panes, with probe spawns plateauing rather than scaling.
//
// This bounds when a probe is STARTED, not one already in flight, so the hard bound is
// this plus STTY_TIMEOUT_MS — still inside the startup deadline that reset() enforces.
const ECHO_POLL_BUDGET_MS = 200

type ExpectedEcho = { projections: readonly string[]; remainingBytes: number }
type PendingWrite = { reply: string; onFailed: (() => void) | undefined }

/** Only a POSIX tty both echoes the reply and still delivers a deferred write. */
function defersWrite(ownerBackend: PtyOwnerBackend): boolean {
  return ownerBackend === 'posix-pty'
}

function replyEchoProjections(
  reply: string,
  ownerBackend: PtyOwnerBackend,
  kernelEchoImpossible: boolean
): readonly string[] {
  if (ownerBackend === 'windows-conpty') {
    // Why: ConPTY's projection is the documented, deterministic ESC-stripped form.
    return [reply.replaceAll('\x1b', '')]
  }
  if (!defersWrite(ownerBackend)) {
    // wsl.exe is ConPTY-hosted but its echo shape is unverified; suppress nothing.
    return []
  }
  // What makes both shapes below safe to match on is that neither starts with ESC, so
  // no query can share a prefix with them. The verbatim echo of a `stty -echoctl` tty
  // is deliberately NOT projected for exactly that reason: it is byte-identical to the
  // reply, so a bare trailing ESC — how any read can end — is a strict prefix of it.
  // That read would be held as an echo candidate, and an expired hold releases its
  // bytes raw, past the query parser, so a query torn at its own ESC is never answered.
  return [
    // ECHOCTL (default cooked tty) renders each control byte as its caret form. This is
    // the ONE projection the probe can retire, because it is the kernel's echo and a
    // cleared ECHO bit is proof it cannot happen.
    ...(kernelEchoImpossible ? [] : [reply.replaceAll('\x1b', '^[')]),
    // readline: `ESC ]` is an unbound binding, so it is eaten (with a bell) and the
    // remainder self-inserts; the ST is eaten the same way. Software echo — survives
    // `quiet`, because readline does this with the tty already raw and ECHO off.
    //
    // This buys display cleanliness ONLY. The bytes self-inserted into readline's edit
    // buffer are still there, so a user who then presses Enter runs them: `bash: 10:
    // command not found`, with nothing on screen to explain it. Not fixable by
    // suppressing harder — undoing it means writing a kill-line into someone's prompt.
    reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
  ]
}

/** Earliest offset whose suffix of `data` is a strict prefix of `projection`, else -1. */
function suffixPrefixOffset(projection: string, data: string): number {
  for (
    let offset = Math.max(0, data.length - projection.length + 1);
    offset < data.length;
    offset += 1
  ) {
    if (projection.startsWith(data.slice(offset))) {
      return offset
    }
  }
  return -1
}

// Why search the whole span: the tty coalesces its echo with whatever the shell and the
// program wrote around it, so anchoring at offset 0 recognizes almost no real echo.
function locateEcho(projections: readonly string[], data: string): PtyStartupReplyEchoMatch {
  let complete: { offset: number; length: number } | null = null
  let partialOffset = -1
  for (const projection of projections) {
    const at = data.indexOf(projection)
    if (at !== -1) {
      if (!complete || at < complete.offset) {
        complete = { offset: at, length: projection.length }
      }
      continue
    }
    const suffix = suffixPrefixOffset(projection, data)
    if (suffix !== -1 && (partialOffset === -1 || suffix < partialOffset)) {
      partialOffset = suffix
    }
  }
  if (complete) {
    return { kind: 'complete', ...complete }
  }
  return partialOffset === -1 ? { kind: 'none' } : { kind: 'partial', offset: partialOffset }
}

function isBetterEchoMatch(
  candidate: PtyStartupReplyEchoMatch,
  best: PtyStartupReplyEchoMatch
): boolean {
  if (candidate.kind === 'none') {
    return false
  }
  if (best.kind === 'none') {
    return true
  }
  if (candidate.kind !== best.kind) {
    return candidate.kind === 'complete'
  }
  return candidate.offset < best.offset
}

/** Owns when a startup color reply is written and how its own echo is recognized. */
export class PtyStartupReplyDelivery {
  private readonly expectedEchoes: ExpectedEcho[] = []
  private readonly pendingWrites: PendingWrite[] = []
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private echoPollDeadline = 0
  private closed = false

  constructor(
    private readonly ownerBackend: PtyOwnerBackend,
    private readonly writeProvider: (data: string) => void,
    private readonly echoProbe?: PtySlaveEchoProbe
  ) {}

  get hasExpectedEcho(): boolean {
    return this.expectedEchoes.length > 0
  }

  /**
   * True once the reply has been written or accepted for a later write.
   *
   * `onFailed` fires only for the second case: a deferred write reports success
   * before it happens, so the caller's bookkeeping for THIS reply is a lie if the
   * write later throws. Scoped per reply because the replies to one query are
   * written independently — one failing says nothing about the ones that landed.
   */
  answer(reply: string, onFailed?: () => void): boolean {
    if (this.closed) {
      return false
    }
    if (!defersWrite(this.ownerBackend)) {
      // Why: ConPTY answers the query itself unless Orca beats it in this turn.
      return this.writeReply(reply)
    }
    // A fresh queue starts a fresh budget, so a second query arriving after the first
    // one exhausted its own still gets probed rather than going straight to guessing.
    if (this.pendingWrites.length === 0) {
      this.echoPollDeadline = Date.now() + ECHO_POLL_BUDGET_MS
    }
    this.pendingWrites.push({ reply, onFailed })
    this.armWriteTimer()
    return true
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
   * Startup window closed. Replies already on the wire stay recognizable, but only
   * across the next few hundred bytes: an unbounded projection would keep deleting
   * matching spans out of ordinary output for the rest of the session.
   */
  reset(): void {
    this.flushPendingWrites()
    for (const expected of this.expectedEchoes) {
      expected.remainingBytes = Math.min(expected.remainingBytes, ECHO_POST_DEADLINE_BUDGET_BYTES)
    }
  }

  /** Teardown: the pty is gone, so an unwritten reply has nowhere left to go. */
  close(): void {
    this.closed = true
    this.clearWriteTimer()
    this.pendingWrites.length = 0
    this.expectedEchoes.length = 0
  }

  private armWriteTimer(delayMs = 0): void {
    if (this.writeTimer) {
      return
    }
    this.writeTimer = setTimeout(() => this.attemptPendingWrites(), delayMs)
    this.writeTimer.unref?.()
  }

  /**
   * Why poll rather than write on the first turn: one deferred turn cannot prove the
   * querying program left cooked mode, and the leak happens precisely because Orca
   * answered before it got there. Waiting costs the program nothing it is not already
   * spending — it is blocked on this reply either way.
   */
  private attemptPendingWrites(): void {
    this.clearWriteTimer()
    if (this.closed || this.pendingWrites.length === 0) {
      return
    }
    if (!this.echoProbe || Date.now() >= this.echoPollDeadline) {
      this.flushPendingWrites()
      return
    }
    void this.echoProbe()
      .catch(() => 'unknown' as const)
      .then((state) => {
        if (this.closed || this.pendingWrites.length === 0) {
          return
        }
        if (state === 'echoing') {
          this.armWriteTimer(ECHO_POLL_INTERVAL_MS)
          return
        }
        // `quiet` retires the kernel caret projection; `unknown` keeps both shapes.
        this.flushPendingWrites(state === 'quiet')
      })
  }

  private flushPendingWrites(kernelEchoImpossible = false): void {
    this.clearWriteTimer()
    for (const pending of this.pendingWrites.splice(0)) {
      this.writeReply(pending.reply, pending.onFailed, kernelEchoImpossible)
    }
  }

  private clearWriteTimer(): void {
    if (!this.writeTimer) {
      return
    }
    clearTimeout(this.writeTimer)
    this.writeTimer = null
  }

  private writeReply(reply: string, onFailed?: () => void, kernelEchoImpossible = false): boolean {
    if (this.closed) {
      return false
    }
    const projections = replyEchoProjections(reply, this.ownerBackend, kernelEchoImpossible)
    // Why: register before write because node-pty can synchronously re-enter onData.
    const expected: ExpectedEcho | null =
      projections.length > 0 ? { projections, remainingBytes: ECHO_SEARCH_BUDGET_BYTES } : null
    if (expected) {
      this.expectedEchoes.push(expected)
    }
    try {
      this.writeProvider(reply)
      return true
    } catch {
      // Why splice by identity, not pop: the write above can re-enter onData and
      // retire a different projection, so the last slot is not necessarily ours.
      const index = expected ? this.expectedEchoes.indexOf(expected) : -1
      if (index !== -1) {
        this.expectedEchoes.splice(index, 1)
      }
      onFailed?.()
      return false
    }
  }
}
