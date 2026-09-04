/**
 * Profile-driven TUI output scrape for agents that lack hooks: working, done
 * and waiting rows are seeded from rendered status text and the idle composer.
 * Shared because main runs this per-PTY under side-effect authority (emitting
 * facts) while the renderer keeps the byte path for remote-runtime PTYs and
 * the kill switch. Agent specifics live in the profile, not here.
 */
import { stripTerminalControl } from './terminal-control-stripping'
import type { TuiAgent } from './tui-agent'

export type AgentOutputStatusProfile = {
  agent: TuiAgent
  /** Arms the scrape from the launch line, before any banner is rendered. */
  isLaunchCommand: (command: string | null | undefined) => boolean
  /** Cheap no-false-negative prefilter on raw bytes before stripping for the banner test. */
  rawTextMayContainBanner: (rawText: string) => boolean
  /** Rendered text that proves this agent's UI is on screen. */
  bannerRe: RegExp
  /** Any match (novel in this chunk) means a submitted prompt is running. */
  activeStatusRes: readonly RegExp[]
  /** The empty composer; after a prompt was seen this means the turn finished. */
  idlePromptRe: RegExp
  /** Approval / question prompts the user must answer before the turn continues. */
  waitingRes?: readonly RegExp[]
  /** Global regex whose first group is the echoed prompt text on a composer line. */
  promptEchoRe: RegExp
  cleanPromptCandidate: (value: string) => string
  isIdlePromptCandidate: (value: string) => boolean
  /** Also drive main's prompt-submission lifecycle from the scrape (agents with no hooks or title status). */
  feedsPromptLifecycle?: boolean
}

export type AgentOutputStatusDetector = {
  observe: (data: string) => boolean
}

export type AgentOutputStatusDetectorArgs = {
  startupCommand?: string | null
  /** Continuity seed for a detector created long after launch (parked watchers):
   *  the banner is off-screen by then, so a turn known to be in flight both arms
   *  the scrape and carries its prompt into the idle-composer done check. */
  inFlightTurn?: { prompt: string } | null
  onWorking: (prompt: string) => void
  onDone?: (prompt: string) => void
  onWaiting?: (prompt: string) => void
}

const RECENT_TEXT_LIMIT = 300
const STATUS_SCAN_TEXT_LIMIT = 4096

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

function anyPatternOverlaps(patterns: readonly RegExp[], context: StatusScanContext): boolean {
  return patterns.some((pattern) => patternOverlapsStatusContext(pattern, context))
}

export function createAgentOutputStatusDetector(
  profile: AgentOutputStatusProfile,
  args: AgentOutputStatusDetectorArgs
): AgentOutputStatusDetector {
  let hasSeenAgentUi = profile.isLaunchCommand(args.startupCommand) || Boolean(args.inFlightTurn)
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

      if (!hasSeenAgentUi) {
        if (!profile.rawTextMayContainBanner(scanRawText)) {
          return false
        }
        const scanText = stripTerminalControl(scanRawText)
        const scanTextWithChunkBoundary = stripTerminalControl(scanRawTextWithChunkBoundary)
        const previousTextWithChunkBoundaryLength = previousRawText
          ? stripTerminalControl(`${previousRawText}\n`).length
          : 0
        if (
          !profile.bannerRe.test(scanText) &&
          !profile.bannerRe.test(
            scanTextWithChunkBoundary.slice(previousTextWithChunkBoundaryLength)
          )
        ) {
          return false
        }
        hasSeenAgentUi = true
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
      for (const promptMatch of scanText.matchAll(profile.promptEchoRe)) {
        const prompt = profile.cleanPromptCandidate(promptMatch[1] ?? '')
        if (prompt && !profile.isIdlePromptCandidate(prompt)) {
          lastSubmittedPrompt = prompt
        }
      }
      // Why: an approval prompt replaces the spinner, so it must win over the
      // working check or the row would read "working" while the agent is parked
      // on a question only the user can answer.
      if (profile.waitingRes && anyPatternOverlaps(profile.waitingRes, statusContext)) {
        args.onWaiting?.(lastSubmittedPrompt)
        return true
      }
      // Why: these agents lack a prompt-start hook. Their TUIs print status text
      // while a submitted prompt is actively running, including no-tool turns
      // that would otherwise jump straight from idle to done.
      if (anyPatternOverlaps(profile.activeStatusRes, statusContext)) {
        args.onWorking(lastSubmittedPrompt)
        return true
      }
      // Why: no reliable Stop hook for no-tool turns. When a submitted prompt has
      // returned to the idle composer, let the pane connection settle-check the
      // current row and mark that turn done.
      if (
        lastSubmittedPrompt &&
        patternOverlapsStatusContext(profile.idlePromptRe, statusContext)
      ) {
        args.onDone?.(lastSubmittedPrompt)
        return true
      }
      return false
    }
  }
}
