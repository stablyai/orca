/** Share split-prefix, BEL/ST and best-effort exit semantics across main local/SSH facts and renderer remote-runtime/kill-switch scans. */

import { ownRetainedString } from './own-retained-string'

type OscTerminator = {
  index: number
  length: number
}

const OSC_133_PREFIX = '\x1b]133;'
const MAX_OSC_CARRY_LENGTH = 4096

function findOscTerminator(data: string, startIndex: number): OscTerminator | null {
  const bel = data.indexOf('\x07', startIndex)
  const st = data.indexOf('\x1b\\', startIndex)

  if (bel === -1 && st === -1) {
    return null
  }
  if (bel !== -1 && (st === -1 || bel < st)) {
    return { index: bel, length: 1 }
  }
  return { index: st, length: 2 }
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
  /** Feed one raw PTY chunk; fires once per complete OSC 133;D sequence. */
  scan: (data: string) => void
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
      onCommandFinished(parseBestEffortExitCode(exitCode))
    }
  }

  const scan = (data: string): void => {
    let combined = carry + data
    // `combined` starts at this index in `data`; negative while it still holds the carry.
    let combinedStartInChunk = -carry.length
    carry = ''

    while (combined.length > 0) {
      const start = combined.indexOf(OSC_133_PREFIX)
      if (start === -1) {
        carry = findPrefixCarry(combined)
        if (carry.length < combined.length) {
          noteOutput()
        }
        break
      }
      if (start > 0) {
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
      combined = combined.slice(sequenceEnd)
      combinedStartInChunk += sequenceEnd
    }
  }

  return {
    scan,
    reset() {
      carry = ''
      adjacentMarkers = ''
    }
  }
}
