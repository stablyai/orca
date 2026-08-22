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

export function replyEchoProjections(
  reply: string,
  ownerBackend: PtyOwnerBackend
): readonly EchoProjection[] {
  if (ownerBackend === 'windows-conpty') {
    // Why: ConPTY's projection is the documented, deterministic ESC-stripped form.
    return [{ needle: reply.replaceAll('\x1b', ''), holdPartial: true }]
  }
  if (ownerBackend !== 'posix-pty') {
    // wsl.exe is ConPTY-hosted but its echo shape is unverified; suppress nothing.
    return []
  }
  return [
    // The kernel's ECHOCTL caret form — the POSIX default.
    { needle: reply.replaceAll('\x1b', '^['), holdPartial: true },
    // Readline rewrites OSC, and echoes it even while the kernel reports ECHO clear.
    ...(reply.includes('\x1b]')
      ? [{ needle: reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', ''), holdPartial: true }]
      : []),
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
