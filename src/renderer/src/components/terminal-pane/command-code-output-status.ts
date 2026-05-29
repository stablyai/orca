type CommandCodeOutputStatusDetector = {
  observe: (data: string) => boolean
}

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  'g'
)
const INCOMPLETE_ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*|\\][^${BEL}${ESC}]*|\\S?)?$`,
  'g'
)
const ORPHAN_SGR_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/g
const RECENT_TEXT_LIMIT = 300
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const LLM_STATUS_WORDS_RE_SOURCE = COMMAND_CODE_LLM_STATUS_WORDS.map(escapeRegExp).join('|')
const ACTIVE_LLM_STATUS_RE = new RegExp(
  `(?:^|[\\r\\n])\\s*(?:${COMMAND_CODE_STATUS_GLYPH_RE_SOURCE}\\s*)?(?:${LLM_STATUS_WORDS_RE_SOURCE})\\b(?:…|\\.\\.\\.)`
)
const ACTIVE_EXECUTION_STATUS_RE = new RegExp(
  `(?:^|[\\r\\n])\\s*(?:${COMMAND_CODE_STATUS_GLYPH_RE_SOURCE}\\s*)?(?:Executing:\\s+\\S|Running\\s*\\()`
)
const IDLE_PROMPT_RE = /(?:^|[\r\n])\s*[❯>]\s+Ask your question\.\.\./

function stripTerminalControl(data: string): string {
  const withoutAnsi = data.replace(ANSI_ESCAPE_RE, '').replace(INCOMPLETE_ANSI_ESCAPE_RE, '')
  let output = ''
  for (let index = 0; index < withoutAnsi.length; index += 1) {
    const code = withoutAnsi.charCodeAt(index)
    if ((code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      continue
    }
    output += withoutAnsi[index]
  }
  return output
}

function cleanPromptCandidate(value: string): string {
  return stripTerminalControl(value).replace(/\s+/g, ' ').trim()
}

function isIdlePromptCandidate(value: string): boolean {
  return value.replace(ORPHAN_SGR_RE, '').replace(/\s+/g, '') === 'Askyourquestion...'
}

function isCommandCodeLaunchCommand(command: string | null | undefined): boolean {
  if (!command) {
    return false
  }
  return /(?:^|[\s;&|])(?:command-code|commandcode|cmdc)(?:\s|$)/.test(command)
}

function patternOverlapsCurrentRawText(
  pattern: RegExp,
  previousRawText: string,
  currentRawText: string
): boolean {
  const previousLength = stripTerminalControl(previousRawText).length
  const combinedText = stripTerminalControl(previousRawText + currentRawText)
  const re = new RegExp(pattern.source, 'g')
  for (const match of combinedText.matchAll(re)) {
    const start = match.index ?? 0
    if (start + match[0].length > previousLength) {
      return true
    }
  }
  return false
}

function isActiveStatusText(currentRawText: string, previousRawText = ''): boolean {
  return (
    patternOverlapsCurrentRawText(ACTIVE_LLM_STATUS_RE, previousRawText, currentRawText) ||
    patternOverlapsCurrentRawText(ACTIVE_EXECUTION_STATUS_RE, previousRawText, currentRawText)
  )
}

function isIdlePromptText(currentRawText: string, previousRawText = ''): boolean {
  return patternOverlapsCurrentRawText(IDLE_PROMPT_RE, previousRawText, currentRawText)
}

export function createCommandCodeOutputStatusDetector(args: {
  startupCommand?: string | null
  onWorking: (prompt: string) => void
  onDone?: (prompt: string) => void
}): CommandCodeOutputStatusDetector {
  let hasSeenCommandCodeUi = isCommandCodeLaunchCommand(args.startupCommand)
  let lastSubmittedPrompt = ''
  let recentRawText = ''

  return {
    observe(data: string): boolean {
      const previousRawText = recentRawText
      const scanText = stripTerminalControl(previousRawText + data)
      const scanTextWithChunkBoundary = stripTerminalControl(
        previousRawText ? `${previousRawText}\n${data}` : data
      )
      recentRawText = (previousRawText + data).slice(-RECENT_TEXT_LIMIT)
      if (
        !hasSeenCommandCodeUi &&
        (/\bCommand Code\b/.test(scanText) || /\bCommand Code\b/.test(scanTextWithChunkBoundary))
      ) {
        hasSeenCommandCodeUi = true
      }
      if (!hasSeenCommandCodeUi) {
        return false
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
      if (
        isActiveStatusText(data, previousRawText) ||
        isActiveStatusText(data, `${previousRawText}\n`)
      ) {
        args.onWorking(lastSubmittedPrompt)
        return true
      }
      // Why: Command Code does not reliably emit a Stop hook for no-tool turns.
      // When a submitted prompt has returned to the idle composer, let the pane
      // connection settle-check the current row and mark that turn done.
      if (
        lastSubmittedPrompt &&
        (isIdlePromptText(data, previousRawText) || isIdlePromptText(data, `${previousRawText}\n`))
      ) {
        args.onDone?.(lastSubmittedPrompt)
        return true
      }
      return false
    }
  }
}
