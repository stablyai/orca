import type { PtyOwnerBackend } from './pty-owner-backend'

// Echo shapes are independent of the writer; match them within coalesced output (#12112, #13137).

/** Hold only non-ESC partials, which cannot steal terminal-query prefixes. ESC-led shapes require complete matches:
 * holding bare ESC takes it from the parser and later releases a torn query raw/unanswered. */
export type EchoProjection = { needle: string; holdPartial: boolean }

export type PtyStartupReplyEchoMatch =
  | { kind: 'complete'; offset: number; length: number }
  | { kind: 'partial'; offset: number }
  | { kind: 'none' }

/* oxlint-disable-next-line no-control-regex -- terminal reply grammars are control sequences */
const PRIVATE_DSR_RE = new RegExp('^\\u001b\\[\\?[0-9][0-9;]*n$')

/** Reject tiny peer-supplied DSR needles: empty params could arm BEL+n and delete ordinary output. */
const MIN_READLINE_NEEDLE_LENGTH = 4

/** Kernel ECHOCTL encodes all controls (BEL→^G), except literal TAB/LF/CR; live bash/zsh/sh PTYs agree.
 * ST-terminated in-tree OSC replies match the old ESC-only form, but foreign/older BEL replies require full encoding. */
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

/** Readline rings BEL for OSC/private-DSR introducers and echoes the residue, even while kernel ECHO is clear. */
function readlineEchoProjection(reply: string): string | null {
  if (reply.includes('\x1b]')) {
    return reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
  }
  // Match full private-DSR grammar so caller widening cannot accidentally arm DA1’s shared-prefix needle.
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
    // Only ST-terminated ConPTY echoes are measured (#9651); BEL behavior remains unknown. Preserve rather than generalize
    // without evidence, per #9500 Decision 3; the required harness does not exist yet.
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
    // Verbatim stty -echoctl echoes match only complete spans: holding ESC could steal a query. We just wrote these exact bytes.
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

// Search all output: PTYs coalesce echo with preceding shell/program bytes.
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
