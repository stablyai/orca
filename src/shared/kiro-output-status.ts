import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { stripTerminalControl } from './terminal-control-stripping'

type KiroOutputStatusDetector = {
  observe: (data: string) => boolean
}

const RECENT_RAW_TEXT_LIMIT = 320
const STATUS_SCAN_TEXT_LIMIT = 4096
const KIRO_UI_RE = /(?:ask a question or describe a task\s*↵|\bkiro_[\w-]+\s*·\s*auto\b)/i
const KIRO_WORKING_RE = /\bThinking(?:\.{3}|…)[ \t]*\(esc to cancel\)/i
const KIRO_DONE_RE = /\bCredits:\s*\d+(?:\.\d+)?\s*[•·]\s*Time:\s*\d+(?:\.\d+)?\s*[a-z]+\b/i

function appendRecentRawText(previous: string, data: string): string {
  if (data.length >= RECENT_RAW_TEXT_LIMIT) {
    return data.slice(-RECENT_RAW_TEXT_LIMIT)
  }
  return (previous + data).slice(-RECENT_RAW_TEXT_LIMIT)
}

function buildScanRawText(previous: string, data: string): string {
  const prefix = previous.slice(-RECENT_RAW_TEXT_LIMIT)
  const budget = STATUS_SCAN_TEXT_LIMIT - prefix.length
  if (data.length <= budget) {
    return prefix + data
  }
  const headLength = Math.max(0, Math.floor((budget - 1) / 2))
  const tailLength = Math.max(0, budget - headLength - 1)
  return `${prefix}${data.slice(0, headLength)}\n${data.slice(-tailLength)}`
}

function newMatchIndex(
  pattern: RegExp,
  previousTextLength: number,
  combinedText: string
): number | null {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  )
  for (const match of combinedText.matchAll(globalPattern)) {
    const index = match.index ?? 0
    if (index + match[0].length > previousTextLength) {
      return index
    }
  }
  return null
}

export function createKiroOutputStatusDetector(args: {
  startupCommand?: string | null
  knownKiroSession?: boolean
  inFlightTurn?: boolean
  onWorking: () => void
  onDone: () => void
}): KiroOutputStatusDetector {
  let hasSeenKiroUi =
    args.knownKiroSession === true ||
    recognizeAgentProcessFromCommandLine(args.startupCommand)?.agent === 'kiro'
  let turnInFlight = args.inFlightTurn === true
  let recentRawText = ''

  return {
    observe(data: string): boolean {
      const previousRawText = recentRawText
      recentRawText = appendRecentRawText(previousRawText, data)
      const combinedText = stripTerminalControl(buildScanRawText(previousRawText, data))
      const previousTextLength = stripTerminalControl(previousRawText).length

      if (!hasSeenKiroUi) {
        const uiIndex = newMatchIndex(KIRO_UI_RE, previousTextLength, combinedText)
        if (uiIndex === null) {
          return false
        }
        hasSeenKiroUi = true
      }

      const workingIndex = newMatchIndex(KIRO_WORKING_RE, previousTextLength, combinedText)
      const doneIndex = newMatchIndex(KIRO_DONE_RE, previousTextLength, combinedText)
      let matched = false

      if (
        workingIndex !== null &&
        (!turnInFlight || (doneIndex !== null && workingIndex > doneIndex))
      ) {
        turnInFlight = true
        args.onWorking()
        matched = true
      }
      if (
        doneIndex !== null &&
        turnInFlight &&
        (workingIndex === null || doneIndex > workingIndex)
      ) {
        turnInFlight = false
        args.onDone()
        matched = true
      }
      return matched
    }
  }
}
