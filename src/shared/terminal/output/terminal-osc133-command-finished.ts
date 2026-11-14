/** Share split-prefix, BEL/ST and best-effort exit semantics across main local/SSH facts and renderer remote-runtime/kill-switch scans. */

import { ownRetainedString } from '../../own-retained-string'
import { TerminalKittyKeyboardModeTracker } from '../protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { extractAllOscTitleEntries } from '../../agent-status/title/osc-title-extraction'
import { extractOscTitleScanTail } from '../../osc-title-scan-tail'

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
  /** Feed one raw PTY chunk; fires once per complete OSC 133;D sequence and returns where the chunk's last one ends, or -1. */
  scan: (data: string, initialAlternateScreen?: boolean) => number
  hasPendingCommandStart: () => boolean
  capturePendingCommandStart: () => (() => boolean) | undefined
  /** Drop the cross-chunk carry (transport teardown / parser reset). */
  reset: () => void
}

export type Osc133TitleEvent = { title: string; end: number }

type ScannerOptions = {
  qualifyScreen?: boolean
  onTitle?: (event: Osc133TitleEvent) => void
  onTitleHandoff?: (event: Osc133TitleEvent) => void
}

export function createOsc133CommandFinishedScanner(
  onCommandFinished: (bestEffortExitCode: number | null) => void,
  /** OSC 133;C marks command start; endInChunk points just past the sequence, where command output begins. */
  onCommandStarted?: (endInChunk: number) => void,
  /** Deferred starts include the bounded post-C carry before the current chunk's output. */
  onShellCommandStarted?: (endInChunk: number, outputPrefix: string) => void,
  options: ScannerOptions = {}
): Osc133CommandFinishedScanner {
  let carry = ''
  // OSC 133 markers seen back to back since the last other output, e.g. 'BC'.
  let adjacentMarkers = ''
  let lastFinishEnd = -1
  let pendingStart: { end: number; committed: boolean } | null = null
  let pendingOutputPrefix = ''
  let titleTail = ''
  let freshTitle: Osc133TitleEvent | undefined
  let pendingTitle: Osc133TitleEvent | undefined
  let modeSeeded = false
  const mode = options.qualifyScreen ? new TerminalKittyKeyboardModeTracker() : null
  let alternate = false

  const commitPendingStart = (): void => {
    if (pendingStart !== null) {
      const { end } = pendingStart
      pendingStart.committed = true
      pendingStart = null
      onShellCommandStarted?.(end, pendingOutputPrefix)
      if (pendingTitle) {
        options.onTitleHandoff?.(pendingTitle)
      }
      pendingTitle = undefined
      pendingOutputPrefix = ''
    }
  }

  const noteOutput = (text: string, end: number): void => {
    commitPendingStart()
    adjacentMarkers = ''
    freshTitle = undefined
    if (options.onTitle) {
      const input = titleTail + text
      const offset = end - input.length
      const titles = extractAllOscTitleEntries(input)
      for (const title of titles) {
        const event = { title: title.title, end: offset + title.end }
        options.onTitle(event)
        if (title.end === input.length) {
          freshTitle = event
        }
      }
      titleTail = extractOscTitleScanTail(input)
    }
  }

  const handleOsc133 = (payload: string, endInChunk: number): void => {
    const [sequence, exitCode] = payload.split(';')
    // Why: read as the command's exit, that `D` retired a live agent's status.
    const closesAppZone = closesAppOsc133Zone(adjacentMarkers, payload)
    if (closesAppZone) {
      pendingStart = null
      pendingOutputPrefix = ''
      pendingTitle = undefined
    } else {
      commitPendingStart()
    }
    const followsPromptEnd = adjacentMarkers.endsWith('B')
    const handoff = followsPromptEnd ? freshTitle : undefined
    if (sequence !== 'B' || adjacentMarkers.length > 0) {
      freshTitle = undefined
    }
    titleTail = ''
    adjacentMarkers = (adjacentMarkers + sequence.slice(0, 1)).slice(-2)
    if (closesAppZone) {
      return
    }
    if (sequence === 'C') {
      onCommandStarted?.(endInChunk)
      if (alternate) {
        return
      }
      if (followsPromptEnd) {
        pendingStart = { end: endInChunk, committed: false }
        pendingOutputPrefix = ''
        pendingTitle = handoff
      } else {
        onShellCommandStarted?.(endInChunk, '')
      }
      return
    }
    if (sequence === 'D') {
      if (alternate) {
        return
      }
      lastFinishEnd = endInChunk
      onCommandFinished(parseBestEffortExitCode(exitCode))
    }
  }

  const scan = (data: string, initialAlternateScreen?: boolean): number => {
    lastFinishEnd = -1
    if (mode && !modeSeeded && initialAlternateScreen !== undefined) {
      mode.scan(initialAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      modeSeeded = true
    }
    alternate = mode?.isAlternateScreen ?? false
    const screens: { end: number; alternate: boolean }[] = []
    mode?.scan(data, (end, alternate) => screens.push({ end, alternate }))
    if (mode?.hasObservedAlternateScreenSwitch) {
      modeSeeded = true
    }
    let screenIndex = 0
    const advanceScreen = (end: number): void => {
      while (screenIndex < screens.length && screens[screenIndex]!.end <= end) {
        alternate = screens[screenIndex++]!.alternate
      }
    }
    if (pendingStart !== null) {
      pendingStart.end = 0
      pendingOutputPrefix = carry
    }
    let combined = carry + data
    // `combined` starts at this index in `data`; negative while it still holds the carry.
    let combinedStartInChunk = -carry.length
    carry = ''

    while (combined.length > 0) {
      const start = combined.indexOf(OSC_133_PREFIX)
      if (start === -1) {
        carry = findPrefixCarry(combined)
        if (carry.length < combined.length) {
          const text = combined.slice(0, combined.length - carry.length)
          noteOutput(text, combinedStartInChunk + text.length)
        }
        break
      }
      if (start > 0) {
        noteOutput(combined.slice(0, start), combinedStartInChunk + start)
      }

      const payloadStart = start + OSC_133_PREFIX.length
      const terminator = findOscTerminator(combined, payloadStart)
      if (!terminator) {
        carry = combined.slice(start)
        if (carry.length > MAX_OSC_CARRY_LENGTH) {
          noteOutput(carry, combinedStartInChunk + combined.length)
          carry = carry.slice(carry.length - MAX_OSC_CARRY_LENGTH)
        }
        carry = ownRetainedString(carry)
        break
      }

      const sequenceEnd = terminator.index + terminator.length
      advanceScreen(combinedStartInChunk + sequenceEnd)
      handleOsc133(
        combined.slice(payloadStart, terminator.index),
        combinedStartInChunk + sequenceEnd
      )
      combined = combined.slice(sequenceEnd)
      combinedStartInChunk += sequenceEnd
    }
    return lastFinishEnd
  }

  return {
    scan,
    hasPendingCommandStart: () => pendingStart !== null,
    capturePendingCommandStart: () => {
      const captured = pendingStart
      return captured ? () => captured.committed : undefined
    },
    reset() {
      carry = ''
      adjacentMarkers = ''
      pendingStart = null
      pendingOutputPrefix = ''
      titleTail = ''
      freshTitle = undefined
      pendingTitle = undefined
      mode?.resetForSnapshot()
      modeSeeded = false
    }
  }
}
