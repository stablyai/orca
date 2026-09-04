/**
 * Command Code output-status profile — that CLI lacks hooks, so working/done
 * agent-status rows are seeded from its rendered status words and idle
 * composer. The scan machinery lives in agent-output-status-detector.ts.
 */
import {
  cleanCommandCodePromptCandidate,
  isCommandCodeIdlePromptCandidate
} from './command-code-prompt-text'
import {
  createAgentOutputStatusDetector,
  type AgentOutputStatusDetector,
  type AgentOutputStatusDetectorArgs,
  type AgentOutputStatusProfile
} from './agent-output-status-detector'
import { stripTerminalControl } from './terminal-control-stripping'
import { escapeRegex } from './string-utils'

export { stripTerminalControl } from './terminal-control-stripping'

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

export const COMMAND_CODE_OUTPUT_STATUS_PROFILE: AgentOutputStatusProfile = {
  agent: 'command-code',
  isLaunchCommand: isCommandCodeLaunchCommand,
  rawTextMayContainBanner: rawTextMayContainCommandCodeBanner,
  bannerRe: COMMAND_CODE_BANNER_RE,
  activeStatusRes: [ACTIVE_LLM_STATUS_RE, ACTIVE_EXECUTION_STATUS_RE],
  idlePromptRe: IDLE_PROMPT_RE,
  promptEchoRe: /(?:^|[\r\n])\s*[❯>]\s+([^\r\n]+)(?=[\r\n])/g,
  cleanPromptCandidate: (value) => cleanCommandCodePromptCandidate(stripTerminalControl(value)),
  isIdlePromptCandidate: isCommandCodeIdlePromptCandidate
}

export function createCommandCodeOutputStatusDetector(
  args: AgentOutputStatusDetectorArgs
): AgentOutputStatusDetector {
  return createAgentOutputStatusDetector(COMMAND_CODE_OUTPUT_STATUS_PROFILE, args)
}
