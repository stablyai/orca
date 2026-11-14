/** Share BEL semantics across main/renderer. Carry OSC state across arbitrary chunks so terminator BELs never ring;
 * CAN/SUB cancel truncated escapes. Reset when replacing streams so old partial OSCs cannot swallow new bells. */
export type BellDetector = {
  /** Reuse the caller’s OSC-introducer scan to avoid another hot-path pass. */
  chunkContainsBell(data: string, hints?: { containsOscIntroducer?: boolean }): boolean
  reset(): void
}

export function createBellDetector(): BellDetector {
  let pendingEscape = false
  let inOsc = false
  let pendingOscEscape = false

  return {
    chunkContainsBell(data: string, hints: { containsOscIntroducer?: boolean } = {}): boolean {
      if (!inOsc && !pendingEscape && !data.includes('\x07')) {
        // Without BEL or an OSC start, ordinary output cannot change bell state.
        if (!(hints.containsOscIntroducer ?? data.includes('\x1b]'))) {
          pendingEscape = data.endsWith('\x1b')
          return false
        }
      }

      for (let i = 0; i < data.length; i += 1) {
        const char = data[i]

        if (inOsc) {
          if (char === '\x18' || char === '\x1a') {
            // CAN/SUB cancel truncated OSCs so the next real BEL can ring.
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
            // An orphan ESC does not consume a following BEL; it is a real bell.
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
