/**
 * Stateful BEL detector that correctly ignores BEL (0x07) bytes
 * occurring inside OSC escape sequences.
 *
 * Why stateful: PTY data arrives in arbitrary chunks, so an OSC sequence
 * may span multiple calls. The detector tracks in-progress escape state
 * across invocations so a BEL used as an OSC terminator is never
 * misinterpreted as a terminal bell.
 *
 * CAN (0x18) / SUB (0x1A) handling: per ECMA-48, these bytes cancel any
 * in-progress escape sequence. Without this, a malformed or truncated OSC
 * string (e.g. from a crashed TUI) would pin `inOsc = true` indefinitely
 * and silently drop the next real BEL as if it were an OSC terminator.
 *
 * reset(): callers should invoke this whenever the underlying byte stream
 * is replaced (e.g. on PTY detach/attach) so state from a previous stream
 * that ended mid-escape does not leak into the next stream.
 */
export type BellDetector = {
  chunkContainsBell(data: string): boolean
  reset(): void
}

export function createBellDetector(): BellDetector {
  let pendingEscape = false
  let inOsc = false
  let pendingOscEscape = false

  return {
    chunkContainsBell(data: string): boolean {
      for (let i = 0; i < data.length; i += 1) {
        const char = data[i]

        if (inOsc) {
          if (char === '\x18' || char === '\x1a') {
            // ECMA-48 escape-cancel codes — abort the in-progress OSC string
            // so a malformed/truncated OSC does not swallow the next BEL.
            inOsc = false
            pendingOscEscape = false
            continue
          }

          if (pendingOscEscape) {
            pendingOscEscape = char === '\x1b'
            if (char === '\\') {
              inOsc = false
              pendingOscEscape = false
            }
            continue
          }

          if (char === '\x07') {
            inOsc = false
            continue
          }

          pendingOscEscape = char === '\x1b'
          continue
        }

        if (pendingEscape) {
          if (char === '\x18' || char === '\x1a') {
            // ECMA-48 escape-cancel codes also abort a pending ESC.
            pendingEscape = false
            continue
          }
          pendingEscape = false
          if (char === ']') {
            inOsc = true
            pendingOscEscape = false
          } else if (char === '\x1b') {
            pendingEscape = true
          } else if (char === '\x07') {
            // A bare ESC is not a valid introducer for any sequence that
            // consumes a following BEL. Treat the BEL as a real terminal
            // bell rather than silently swallowing it with the orphan ESC.
            return true
          }
          continue
        }

        if (char === '\x1b') {
          pendingEscape = true
          continue
        }

        if (char === '\x07') {
          return true
        }
      }

      return false
    },
    reset(): void {
      pendingEscape = false
      inOsc = false
      pendingOscEscape = false
    }
  }
}
