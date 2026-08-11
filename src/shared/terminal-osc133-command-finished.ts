/**
 * Chunk-boundary-safe OSC 133;D (command finished) scanner.
 *
 * Why shared: terminal-side-effect-authority.md (slice 3) makes main emit
 * `command-finished` facts from its per-PTY tracker for local/SSH PTYs, while
 * the renderer keeps byte-parsing for remote-runtime PTYs and the
 * kill-switch-off path. The carry semantics (split prefixes, BEL/ST
 * terminators, best-effort exit codes) must be identical in both.
 */

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

export type Osc133CommandFinishedScanner = {
  /** Feed one raw PTY chunk; fires once per complete OSC 133;D sequence. */
  scan: (data: string) => void
  /** Drop the cross-chunk carry (transport teardown / parser reset). */
  reset: () => void
}

export function createOsc133CommandFinishedScanner(
  onCommandFinished: (bestEffortExitCode: number | null) => void,
  /** OSC 133;C — the shell exec'd a command; the pane's foreground changed. */
  onCommandStarted?: () => void
): Osc133CommandFinishedScanner {
  let carry = ''

  const handleOsc133 = (payload: string): void => {
    const [sequence, exitCode] = payload.split(';')
    if (sequence === 'C') {
      onCommandStarted?.()
      return
    }
    if (sequence === 'D') {
      onCommandFinished(parseBestEffortExitCode(exitCode))
    }
  }

  const scan = (data: string): void => {
    let combined = carry + data
    carry = ''

    while (combined.length > 0) {
      const start = combined.indexOf(OSC_133_PREFIX)
      if (start === -1) {
        carry = findPrefixCarry(combined)
        return
      }

      const payloadStart = start + OSC_133_PREFIX.length
      const terminator = findOscTerminator(combined, payloadStart)
      if (!terminator) {
        carry = combined.slice(start)
        if (carry.length > MAX_OSC_CARRY_LENGTH) {
          carry = carry.slice(carry.length - MAX_OSC_CARRY_LENGTH)
        }
        return
      }

      handleOsc133(combined.slice(payloadStart, terminator.index))
      combined = combined.slice(terminator.index + terminator.length)
    }
  }

  return {
    scan,
    reset() {
      carry = ''
    }
  }
}
