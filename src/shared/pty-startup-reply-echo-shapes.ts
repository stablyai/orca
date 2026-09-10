import type { PtyOwnerBackend } from './pty-owner-backend'

// The shapes a reply written to the PTY master can come back as, and how one is located
// inside a coalesced read. Split from the write path: what an echo LOOKS like is
// independent of who writes it (#12112, #13137).

/**
 * One echo shape to watch for.
 *
 * `holdPartial` is the safety bit. A shape that does NOT start with ESC can be held as a
 * partial candidate across reads, because no terminal query can share a prefix with it —
 * holding it steals nothing. A shape that DOES start with ESC must never be held: a read
 * ending on a bare ESC is a strict prefix of it, the hold would take that ESC away from
 * the query parser, and an expired hold releases it raw — so a query torn at its own ESC
 * would never be answered. Such a shape is matched only when it arrives complete.
 */
export type EchoProjection = { needle: string; holdPartial: boolean }

export type PtyStartupReplyEchoMatch =
  | { kind: 'complete'; offset: number; length: number }
  | { kind: 'partial'; offset: number }
  | { kind: 'none' }

/* oxlint-disable-next-line no-control-regex -- terminal reply grammars are control sequences */
const PRIVATE_DSR_RE = new RegExp('^\\u001b\\[\\?[0-9][0-9;]*n$')

/**
 * Floor on a BEL-led needle. The containment grammar accepts an empty parameter list
 * (`CSI ? n`), and `answerLiveQueryReply` takes client-supplied bytes on the relay path —
 * so without this a peer could arm a two-byte `BEL n` needle that deletes the first
 * bell-then-`n` in ordinary output. Below this length the match is not worth the span.
 */
const MIN_READLINE_NEEDLE_LENGTH = 4

/**
 * ECHOCTL carets EVERY control, not just ESC. Every OSC reply Orca emits is ST-terminated
 * (terminal-osc-color-reply.ts) and ST is ESC-led, so this is byte-identical to the old
 * ESC-only encoding for all of them. It matters for a BEL-terminated reply, which the
 * grammar admits from a foreign or older emulator: the tty prints that BEL as `^G`, where
 * encoding ESC alone left a literal BEL in the needle — a string no tty produces.
 *
 * Shapes verified against a live pty; bash, zsh and sh echo identically here, because this
 * is the kernel and not the shell.
 *
 * TAB/LF/CR are exempt: ECHOCTL passes them through literally, so caret-encoding them
 * would over-predict. No reply grammar carries one today, which is why this is a guard
 * rather than a fix.
 */
function caretEncodeControls(reply: string): string {
  let out = ''
  for (const ch of reply) {
    const code = ch.charCodeAt(0)
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ch
    } else if (code < 0x20) {
      out += `^${String.fromCharCode(code + 0x40)}`
    } else {
      out += code === 0x7f ? '^?' : ch
    }
  }
  return out
}

/**
 * Readline swallows the escape introducer, rings the bell, and echoes the residue — BEL
 * replaces `ESC ]` for an OSC reply and `ESC [ ?` for a private DSR. The DSR shape had no
 * projection at all, so `CSI ? … n` was never matched at a readline prompt.
 */
function readlineEchoProjection(reply: string): string | null {
  if (reply.includes('\x1b]')) {
    return reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
  }
  // Keyed on the private-DSR grammar, not a bare `ESC [ ?` prefix: DA1 (`ESC [ ? 1 ; 2 c`)
  // shares that prefix and is kept off this path today only by a predicate one module away.
  // Matching the final `n` here means widening that predicate cannot silently arm a needle.
  if (!PRIVATE_DSR_RE.test(reply)) {
    return null
  }
  const needle = `\x07${reply.slice(3)}`
  return needle.length >= MIN_READLINE_NEEDLE_LENGTH ? needle : null
}

export function replyEchoProjections(
  reply: string,
  ownerBackend: PtyOwnerBackend
): readonly EchoProjection[] {
  if (ownerBackend === 'windows-conpty') {
    // ESC-stripped, but observed only for the ST-terminated OSC 10/11 reply that #9651
    // was reported against — which is every OSC reply Orca emits. Whether conhost leaves a
    // BEL literal, carets it, or eats it is unknown, so this shares the latent defect the
    // POSIX caret form had. Not corrected blind: #9500 Decision 3 forbids generalising the
    // ESC-strip without evidence, and the harness that would produce it does not exist.
    return [{ needle: reply.replaceAll('\x1b', ''), holdPartial: true }]
  }
  if (ownerBackend !== 'posix-pty') {
    // wsl.exe is ConPTY-hosted but its echo shape is unverified; suppress nothing.
    return []
  }
  const readline = readlineEchoProjection(reply)
  return [
    // The kernel's ECHOCTL caret form — the POSIX default.
    { needle: caretEncodeControls(reply), holdPartial: true },
    // Readline rewrites the reply, and echoes it even while the kernel reports ECHO clear.
    ...(readline === null ? [] : [{ needle: readline, holdPartial: true }]),
    // A `stty -echoctl` tty echoes the reply verbatim. Complete-match-only, because it
    // starts with ESC — see `holdPartial`. We just wrote these exact bytes, and we are
    // the terminal, so a child emitting the identical span in the same window is not a
    // case worth trading a stolen query for.
    { needle: reply, holdPartial: false }
  ]
}

/** Earliest offset whose suffix of `data` is a strict prefix of `needle`, else -1. */
function suffixPrefixOffset(needle: string, data: string): number {
  for (
    let offset = Math.max(0, data.length - needle.length + 1);
    offset < data.length;
    offset += 1
  ) {
    if (needle.startsWith(data.slice(offset))) {
      return offset
    }
  }
  return -1
}

// Why search the whole span: the tty coalesces its echo with whatever the shell and the
// program wrote around it, so anchoring at offset 0 recognizes almost no real echo.
export function locateEcho(
  projections: readonly EchoProjection[],
  data: string
): PtyStartupReplyEchoMatch {
  let complete: { offset: number; length: number } | null = null
  let partialOffset = -1
  for (const projection of projections) {
    const at = data.indexOf(projection.needle)
    if (at !== -1) {
      if (!complete || at < complete.offset) {
        complete = { offset: at, length: projection.needle.length }
      }
      continue
    }
    if (!projection.holdPartial) {
      continue
    }
    const suffix = suffixPrefixOffset(projection.needle, data)
    if (suffix !== -1 && (partialOffset === -1 || suffix < partialOffset)) {
      partialOffset = suffix
    }
  }
  if (complete) {
    return { kind: 'complete', ...complete }
  }
  return partialOffset === -1 ? { kind: 'none' } : { kind: 'partial', offset: partialOffset }
}

export function isBetterEchoMatch(
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
