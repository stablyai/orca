/** Share split-prefix, BEL/ST and best-effort exit semantics across main local/SSH facts and renderer remote-runtime/kill-switch scans. */

import { ownRetainedString } from '../../text/own-retained-string'

type OscTerminator = {
  index: number
  length: number
}

const OSC_133_PREFIX = '\x1b]133;'
// 128 + SIGSTOP/SIGTSTP/SIGTTIN/SIGTTOU, as numbered on macOS (17, 18, 21, 22) and Linux (19, 20, 21, 22).
// Conservative ambiguity exception, not suspension proof: 145/146 are stops only on macOS (SIGSTOP/SIGTSTP).
const JOB_STOP_STATUSES: ReadonlySet<number> = new Set([145, 146, 147, 148, 149, 150])
const MAX_OSC_CARRY_LENGTH = 4096

// Why stop at the first ESC: an ST is the first ESC after the payload, so the search never walks past
// the next marker; a BEL-terminated burst of markers is scanned once rather than once per marker.
function findOscTerminator(data: string, startIndex: number): OscTerminator | null {
  const bel = data.indexOf('\x07', startIndex)
  const esc = data.indexOf('\x1b', startIndex)
  if (esc !== -1 && (bel === -1 || esc < bel) && data[esc + 1] === '\\') {
    return { index: esc, length: 2 }
  }
  return bel === -1 ? null : { index: bel, length: 1 }
}

function parseBestEffortExitCode(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function findPrefixCarry(data: string): string {
  const maxCarryLength = Math.min(data.length, OSC_133_PREFIX.length - 1)
  for (let length = maxCarryLength; length > 0; length -= 1) {
    const suffix = data.slice(data.length - length)
    if (OSC_133_PREFIX.startsWith(suffix)) {
      return suffix
    }
  }
  return ''
}

/** OMP closes its own live prompt zones with adjacent B C D;0 (#10923); a shell’s C follows typed command text.
 * adjacentMarkers holds preceding consecutive markers (for example BC). */
export function closesAppOsc133Zone(adjacentMarkers: string, payload: string): boolean {
  const [sequence, exitCode] = payload.split(';')
  return sequence === 'D' && exitCode === '0' && adjacentMarkers.endsWith('BC')
}

export type Osc133CommandFinishedScanner = {
  /** Feed one raw PTY chunk; fires once per complete OSC 133;D sequence and returns where the chunk's last one ends, or -1. */
  scan: (data: string) => number
  /** Drop the cross-chunk carry (transport teardown / parser reset). */
  reset: () => void
}

export function createOsc133CommandFinishedScanner(
  onCommandFinished: (bestEffortExitCode: number | null) => void,
  /** OSC 133;C marks command start; endInChunk points just past the sequence, where command output begins. */
  onCommandStarted?: (endInChunk: number) => void
): Osc133CommandFinishedScanner {
  let carry = ''
  // OSC 133 markers seen back to back since the last other output, e.g. 'BC'.
  let adjacentMarkers = ''
  let lastFinishEnd = -1

  const noteOutput = (): void => {
    adjacentMarkers = ''
  }

  const handleOsc133 = (payload: string, endInChunk: number): void => {
    const [sequence, exitCode] = payload.split(';')
    // Why: read as the command's exit, that `D` retired a live agent's status.
    const closesAppZone = closesAppOsc133Zone(adjacentMarkers, payload)
    adjacentMarkers = (adjacentMarkers + sequence.slice(0, 1)).slice(-2)
    if (closesAppZone) {
      return
    }
    if (sequence === 'C') {
      onCommandStarted?.(endInChunk)
      return
    }
    if (sequence === 'D') {
      lastFinishEnd = endInChunk
      onCommandFinished(parseBestEffortExitCode(exitCode))
    }
  }

  const scan = (data: string): number => {
    lastFinishEnd = -1
    const combined = carry + data
    // `combined` starts at this index in `data`; negative while it still holds the carry.
    const combinedStartInChunk = -carry.length
    carry = ''
    let offset = 0

    while (offset < combined.length) {
      const start = combined.indexOf(OSC_133_PREFIX, offset)
      if (start === -1) {
        const rest = combined.slice(offset)
        carry = findPrefixCarry(rest)
        if (carry.length < rest.length) {
          noteOutput()
        }
        break
      }
      if (start > offset) {
        noteOutput()
      }

      const payloadStart = start + OSC_133_PREFIX.length
      const terminator = findOscTerminator(combined, payloadStart)
      if (!terminator) {
        carry = combined.slice(start)
        if (carry.length > MAX_OSC_CARRY_LENGTH) {
          carry = carry.slice(carry.length - MAX_OSC_CARRY_LENGTH)
        }
        carry = ownRetainedString(carry)
        break
      }

      const sequenceEnd = terminator.index + terminator.length
      handleOsc133(
        combined.slice(payloadStart, terminator.index),
        combinedStartInChunk + sequenceEnd
      )
      offset = sequenceEnd
    }
    return lastFinishEnd
  }

  return {
    scan,
    reset() {
      carry = ''
      adjacentMarkers = ''
    }
  }
}

/** A suspended job (Ctrl-Z) finishes its command with a stop status while its process lives on. */
export function isJobStopStatus(exitCode: number | null): boolean {
  return exitCode !== null && JOB_STOP_STATUSES.has(exitCode)
}
