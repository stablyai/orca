/**
 * Command Code TUI output scrape — that CLI lacks hooks, so working/done
 * agent-status rows are seeded from its rendered status words and idle
 * composer. Shared because main runs this per-PTY under side-effect authority
 * (emitting command-code facts) while the renderer keeps the byte path for
 * remote-runtime PTYs and the kill switch.
 */
import {
  cleanCommandCodePromptCandidate,
  isCommandCodeIdlePromptCandidate
} from './command-code-prompt-text'
import { stripTerminalControl } from './terminal-control-stripping'
import { escapeRegex } from './string-utils'

export { stripTerminalControl } from './terminal-control-stripping'

type CommandCodeOutputStatusDetector = {
  observe: (data: string) => boolean
}

const RECENT_TEXT_LIMIT = 300
const STATUS_SCAN_TEXT_LIMIT = 4096
const COMMAND_CODE_STATUS_GLYPH_RE_SOURCE = '[·○◇☆✧⌘✻⎿]'
// Why: Command Code 0.27.3 randomizes its in-flight LLM status from this
// package-local list, so checking only a few examples misses real active turns.
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
const IDLE_PROMPT_RE = /(?:^|[\r\n])\s*[❯>]\s+Ask your question\.\.\./
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
  // Why: every terminal pane observes this detector, but only Command Code
  // panes need the ANSI/control stripping path. Use a broad no-false-negative
  // letter prefilter so ANSI styling inside the banner words still works.
  return rawText.includes('C') && rawText.includes('o') && rawText.includes('d')
}

function appendRecentRawText(previousRawText: string, data: string): string {
  if (data.length >= RECENT_TEXT_LIMIT) {
    return data.slice(-RECENT_TEXT_LIMIT)
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
  // Why: pasted terminal echoes can produce megabyte-sized chunks. Status
  // detection only needs chunk-boundary context plus recent output, so scan the
  // start and end windows instead of regex-stripping the full PTY payload.
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
  /** Continuity seed for a detector created long after launch (parked watchers):
   *  the banner is off-screen by then, so a turn known to be in flight both arms
   *  the scrape and carries its prompt into the idle-composer done check. */
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
      for (const promptMatch of scanText.matchAll(/(?:^|[\r\n])\s*[❯>]\s+([^\r\n]+)(?=[\r\n])/g)) {
        const prompt = cleanPromptCandidate(promptMatch[1] ?? '')
        if (prompt && !isIdlePromptCandidate(prompt)) {
          lastSubmittedPrompt = prompt
        }
      }
      // Why: Command Code lacks a prompt-start hook. Its TUI prints these
      // status words while a submitted prompt is actively running, including
      // no-tool turns that would otherwise jump straight from idle to done.
      if (isActiveStatusText(statusContext)) {
        args.onWorking(lastSubmittedPrompt)
        return true
      }
      // Why: Command Code does not reliably emit a Stop hook for no-tool turns.
      // When a submitted prompt has returned to the idle composer, let the pane
      // connection settle-check the current row and mark that turn done.
      if (lastSubmittedPrompt && isIdlePromptText(statusContext)) {
        args.onDone?.(lastSubmittedPrompt)
        return true
      }
      return false
    }
  }
}
