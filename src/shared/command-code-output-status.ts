/** Command Code lacks hooks, so scrape rendered status/composer text. Main emits facts under side-effect authority; renderer retains remote-PTY/kill-switch observation. */
import {
  cleanCommandCodePromptCandidate,
  isCommandCodeIdlePromptCandidate
} from './command-code-prompt-text'
import { stripTerminalControl } from './terminal-control-stripping'
import { escapeRegex } from './string-utils'
import { ownRetainedString } from './own-retained-string'

type CommandCodeOutputStatusDetector = {
  observe: (data: string) => boolean
}

const RECENT_TEXT_LIMIT = 300
const STATUS_SCAN_TEXT_LIMIT = 4096
const COMMAND_CODE_STATUS_GLYPH_RE_SOURCE = '[·○◇☆✧⌘✻⎿]'
// Command Code 0.27.3 randomizes active LLM labels from this list; partial examples miss real turns.
const COMMAND_CODE_LLM_STATUS_WORDS = [
  'Thinking',
  'Pondering',
  'Contemplating',
  'Reasoning',
  'Reflecting',
  'Considering',
  'Deliberating',
  'Analyzing',
  'Evaluating',
  'Examining',
  'Inspecting',
  'Investigating',
  'Reviewing',
  'Researching',
  'Studying',
  'Exploring',
  'Mapping',
  'Tracing',
  'Parsing',
  'Processing',
  'Calculating',
  'Computing',
  'Synthesizing',
  'Planning',
  'Outlining',
  'Sketching',
  'Drafting',
  'Composing',
  'Crafting',
  'Building',
  'Assembling',
  'Constructing',
  'Designing',
  'Formulating',
  'Structuring',
  'Organizing',
  'Preparing',
  'Refining',
  'Polishing',
  'Honing',
  'Tuning',
  'Aligning',
  'Connecting',
  'Resolving',
  'Weaving',
  'Threading',
  'Sculpting',
  'Crystallizing',
  'Channeling',
  'Conjuring',
  'Brewing',
  'Working',
  'Cogitating',
  'Ruminating',
  'Hypothesizing',
  'Conceptualizing',
  'Philosophizing',
  'Deciphering',
  'Demystifying',
  'Articulating',
  'Illuminating',
  'Elaborating',
  'Orchestrating',
  'Choreographing',
  'Architecting',
  'Calibrating',
  'Materializing',
  'Visualizing',
  'Harmonizing',
  'Contemplificating',
  'Supercalifragilisting',
  'Bibbidibobbidibooing',
  'Abracadabraing',
  'Hocuspocusing',
  'Razzmatazzing'
] as const

const LLM_STATUS_WORDS_RE_SOURCE = COMMAND_CODE_LLM_STATUS_WORDS.map(escapeRegex).join('|')
const ACTIVE_LLM_STATUS_RE = new RegExp(
  `(?:^|[\\r\\n])\\s*(?:${COMMAND_CODE_STATUS_GLYPH_RE_SOURCE}\\s*)?(?:${LLM_STATUS_WORDS_RE_SOURCE})\\b(?:…|\\.\\.\\.)`
)
const ACTIVE_EXECUTION_STATUS_RE = new RegExp(
  `(?:^|[\\r\\n])\\s*(?:${COMMAND_CODE_STATUS_GLYPH_RE_SOURCE}\\s*)?(?:Executing:\\s+\\S|Running\\s*\\()`
)
const IDLE_PROMPT_RE = /(?:^|[\r\n])\s*[\u276F>]\s+Ask your question\.\.\./
const SEMVER_NUMBER_RE_SOURCE = '(?:0|[1-9]\\d*)'
const SEMVER_PRERELEASE_IDENTIFIER_RE_SOURCE = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const SEMVER_BUILD_IDENTIFIER_RE_SOURCE = '[0-9A-Za-z-]+'
const COMMAND_CODE_BANNER_RE = new RegExp(
  `(?:^|[\\r\\n])[ \\t]*#[ \\t]+Command Code[ \\t]+v` +
    `${SEMVER_NUMBER_RE_SOURCE}\\.${SEMVER_NUMBER_RE_SOURCE}\\.${SEMVER_NUMBER_RE_SOURCE}` +
    `(?:-${SEMVER_PRERELEASE_IDENTIFIER_RE_SOURCE}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER_RE_SOURCE})*)?` +
    `(?:\\+${SEMVER_BUILD_IDENTIFIER_RE_SOURCE}(?:\\.${SEMVER_BUILD_IDENTIFIER_RE_SOURCE})*)?` +
    `(?=[ \\t]*[\\r\\n])`
)

function cleanPromptCandidate(value: string): string {
  return cleanCommandCodePromptCandidate(stripTerminalControl(value))
}

function isIdlePromptCandidate(value: string): boolean {
  return isCommandCodeIdlePromptCandidate(value)
}

function isCommandCodeLaunchCommand(command: string | null | undefined): boolean {
  if (!command) {
    return false
  }
  return /(?:^|[\s;&|])(?:command-code|commandcode|cmdc)(?:\s|$)/.test(command)
}

function rawTextMayContainCommandCodeBanner(rawText: string): boolean {
  // All panes observe this; a no-false-negative letter prefilter avoids control stripping on unrelated panes, including ANSI-split words.
  return rawText.includes('C') && rawText.includes('o') && rawText.includes('d')
}

// Control stripping only removes bytes; without raw # the banner regex cannot match.
const BANNER_REQUIRED_RAW_CHAR = '#'

/** Whole carry/chunk prefilter over-admits relative to windows that drop middle content; it cannot turn a match into a miss. */
function rawChunkMayContainCommandCodeBanner(previousRawText: string, data: string): boolean {
  return (
    data.includes(BANNER_REQUIRED_RAW_CHAR) || previousRawText.includes(BANNER_REQUIRED_RAW_CHAR)
  )
}

function appendRecentRawText(previousRawText: string, data: string): string {
  if (data.length >= RECENT_TEXT_LIMIT) {
    return ownRetainedString(data.slice(-RECENT_TEXT_LIMIT))
  }
  return (previousRawText + data).slice(-RECENT_TEXT_LIMIT)
}

function buildStatusScanRawText(prefix: string, data: string): string {
  const boundedPrefix =
    prefix.length > RECENT_TEXT_LIMIT + 1 ? prefix.slice(-(RECENT_TEXT_LIMIT + 1)) : prefix
  const dataBudget = STATUS_SCAN_TEXT_LIMIT - boundedPrefix.length

  if (dataBudget <= 0) {
    return boundedPrefix.slice(-STATUS_SCAN_TEXT_LIMIT)
  }
  if (data.length <= dataBudget) {
    return boundedPrefix + data
  }

  const headBudget = Math.max(0, Math.floor((dataBudget - 1) / 2))
  const tailBudget = Math.max(0, dataBudget - headBudget - 1)
  const head = headBudget > 0 ? data.slice(0, headBudget) : ''
  const tail = tailBudget > 0 ? data.slice(-tailBudget) : ''
  // Megabyte pasted echoes need only boundary/recent context; scan head/tail windows instead of stripping the entire payload.
  return `${boundedPrefix}${head}\n${tail}`
}

function patternOverlapsSanitizedText(
  pattern: RegExp,
  previousTextLength: number,
  combinedText: string
): boolean {
  const re = new RegExp(pattern.source, 'g')
  for (const match of combinedText.matchAll(re)) {
    const start = match.index ?? 0
    if (start + match[0].length > previousTextLength) {
      return true
    }
  }
  return false
}

type StatusScanContext = {
  combinedText: string
  previousTextLength: number
  combinedTextWithChunkBoundary: string
  previousTextWithChunkBoundaryLength: number
}

function patternOverlapsStatusContext(pattern: RegExp, context: StatusScanContext): boolean {
  return (
    patternOverlapsSanitizedText(pattern, context.previousTextLength, context.combinedText) ||
    patternOverlapsSanitizedText(
      pattern,
      context.previousTextWithChunkBoundaryLength,
      context.combinedTextWithChunkBoundary
    )
  )
}

function isActiveStatusText(context: StatusScanContext): boolean {
  return (
    patternOverlapsStatusContext(ACTIVE_LLM_STATUS_RE, context) ||
    patternOverlapsStatusContext(ACTIVE_EXECUTION_STATUS_RE, context)
  )
}

function isIdlePromptText(context: StatusScanContext): boolean {
  return patternOverlapsStatusContext(IDLE_PROMPT_RE, context)
}

export function createCommandCodeOutputStatusDetector(args: {
  startupCommand?: string | null
  /** Seed parked watchers after the banner scrolls away, arming an existing turn and retaining its prompt for idle completion. */
  inFlightTurn?: { prompt: string } | null
  onWorking: (prompt: string) => void
  onDone?: (prompt: string) => void
}): CommandCodeOutputStatusDetector {
  let hasSeenCommandCodeUi =
    isCommandCodeLaunchCommand(args.startupCommand) || Boolean(args.inFlightTurn)
  let lastSubmittedPrompt = args.inFlightTurn?.prompt ?? ''
  let recentRawText = ''

  return {
    observe(data: string): boolean {
      const previousRawText = recentRawText
      recentRawText = appendRecentRawText(previousRawText, data)
      // Prefilter before window builds so unrelated panes avoid two ~4KB strings per chunk.
      if (!hasSeenCommandCodeUi && !rawChunkMayContainCommandCodeBanner(previousRawText, data)) {
        return false
      }
      const scanRawText = buildStatusScanRawText(previousRawText, data)
      const scanRawTextWithChunkBoundary = previousRawText
        ? buildStatusScanRawText(`${previousRawText}\n`, data)
        : scanRawText

      if (!hasSeenCommandCodeUi) {
        if (!rawTextMayContainCommandCodeBanner(scanRawText)) {
          return false
        }
        const scanText = stripTerminalControl(scanRawText)
        const scanTextWithChunkBoundary = stripTerminalControl(scanRawTextWithChunkBoundary)
        const previousTextWithChunkBoundaryLength = previousRawText
          ? stripTerminalControl(`${previousRawText}\n`).length
          : 0
        if (
          !COMMAND_CODE_BANNER_RE.test(scanText) &&
          !COMMAND_CODE_BANNER_RE.test(
            scanTextWithChunkBoundary.slice(previousTextWithChunkBoundaryLength)
          )
        ) {
          return false
        }
        hasSeenCommandCodeUi = true
      }

      const scanText = stripTerminalControl(scanRawText)
      const scanTextWithChunkBoundary = stripTerminalControl(scanRawTextWithChunkBoundary)
      const previousTextLength = previousRawText ? stripTerminalControl(previousRawText).length : 0
      const previousTextWithChunkBoundaryLength = previousRawText
        ? stripTerminalControl(`${previousRawText}\n`).length
        : 0
      const statusContext: StatusScanContext = {
        combinedText: scanText,
        previousTextLength,
        combinedTextWithChunkBoundary: scanTextWithChunkBoundary,
        previousTextWithChunkBoundaryLength
      }
      for (const promptMatch of scanText.matchAll(
        /(?:^|[\r\n])\s*[\u276F>]\s+([^\r\n]+)(?=[\r\n])/g
      )) {
        const prompt = cleanPromptCandidate(promptMatch[1] ?? '')
        if (prompt && !isIdlePromptCandidate(prompt)) {
          lastSubmittedPrompt = prompt
        }
      }
      // Without prompt-start hooks, active words detect submitted/no-tool turns that otherwise jump idle to done.
      if (isActiveStatusText(statusContext)) {
        args.onWorking(lastSubmittedPrompt)
        return true
      }
      // No-tool turns may omit Stop; idle composer lets the connection settle-check and complete the current row.
      if (lastSubmittedPrompt && isIdlePromptText(statusContext)) {
        args.onDone?.(lastSubmittedPrompt)
        return true
      }
      return false
    }
  }
}
