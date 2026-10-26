import { isQoderTerminalTitle } from './qoder-terminal-title'
import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName
} from './agent-name-token-match'
import {
  containsAgentSpinnerGlyph,
  isCursorAgentTitle,
  isDshTerminalTitle
} from './agent-title-core'
import { isDeepSeekBuildTerminalTitle } from './dsb-terminal-title'

export { DSH_WHALE, isDshTerminalTitle } from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  getPiCompatibleSyntheticAgentLabel,
  isLegacyPiCompatibleTitle
} from './pi-compatible-synthetic-title'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import { memoizeTitleClassification } from './terminal-title-classification-memo'
import type { TerminalAgent } from './terminal-agent'

export const CLAUDE_IDLE = '\u2733' // ✳ (eight-spoked asterisk — Claude Code idle prefix)
const CLAUDE_MANAGEMENT_TITLE_RE =
  /^\s*(?:"(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?"|'(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?'|(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?)\s+agents\s*$/i

export const GEMINI_WORKING = '\u2726' // ✦
export const GEMINI_SILENT_WORKING = '\u23F2' // ⏲
export const GEMINI_IDLE = '\u25C7' // ◇
export const GEMINI_PERMISSION = '\u270B' // ✋

export function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) {
      return true
    }
  }
  return false
}

export function isGeminiTerminalTitle(title: string): boolean {
  // Reject other agents’ identity frames before generic Gemini glyphs; DSH shares ✦ with Gemini.
  if (isQoderTerminalTitle(title)) {
    return false
  }
  if (isDshTerminalTitle(title) || isDeepSeekBuildTerminalTitle(title)) {
    return false
  }
  // Why: Gemini OSC glyphs are stronger evidence than any cwd/session text.
  if (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE)
  ) {
    return true
  }
  // Pi/OMP session paths can mention Gemini without identifying the agent.
  if (isPiAgentTitle(title)) {
    return false
  }
  // Antigravity model names contain Gemini; defer token matches to agy identity while keeping explicit Gemini glyphs decisive.
  if (titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)) {
    return false
  }
  return titleHasAgentName(title, 'gemini')
}

// Collapse only Grok’s spinner - phrase - grok frame; both delimiters exclude Claude/Codex task mentions.
// Keep unspun session titles unchanged and accept spinner + grok so our collapsed label stays idempotent.
const GROK_ROTATING_FRAME_RE = /^[\u2800-\u28FF]+\s+-\s+[\s\S]+?\s-\s+grok\s*$/i
const GROK_COLLAPSED_WORKING_TITLE_RE = /^[\u2800-\u28FF]+\s+grok\s*$/i

export function isGrokRotatingWorkingTitle(title: string): boolean {
  if (!containsBrailleSpinner(title)) {
    return false
  }
  return GROK_ROTATING_FRAME_RE.test(title) || GROK_COLLAPSED_WORKING_TITLE_RE.test(title)
}

export function isPiAgentTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title)
}

/** Scope Claude-only prompt-cache timing to Claude title conventions. */
function computeIsClaudeAgent(title: string): boolean {
  if (!title || isClaudeManagementTitle(title) || isOpenCodeNativeTitle(title)) {
    return false
  }
  // DSH uses braille too; its whale identity must win over the generic Claude spinner heuristic.
  if (isDshTerminalTitle(title)) {
    return false
  }
  const lower = title.toLowerCase()

  // Claude-specific status prefixes outrank agent names mentioned in task text.
  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return true
  }
  // Claude owns . / * status prefixes even when its task mentions another agent.
  if (title.startsWith('. ') || title.startsWith('* ')) {
    return true
  }
  // Why: a working DeepSeek Build title uses Claude's braille frame.
  if (isDeepSeekBuildTerminalTitle(title)) {
    return false
  }
  if (containsAgentSpinnerGlyph(title)) {
    // Other agents use braille; reject Cursor identity, but keep Claude tasks merely mentioning a cursor.
    return !isCursorAgentTitle(title) && !lower.includes('openclaude')
  }
  // Permission titles can omit status prefixes; token boundaries exclude claude-scratch paths and task mentions.
  const trimmedTitle = title.trimStart()
  if (
    trimmedTitle.toLowerCase().startsWith('claude') &&
    titleHasAgentName(trimmedTitle, 'claude')
  ) {
    return true
  }

  return false
}

/** Pure in `title` — memoized so repeated selector reads skip the regex ladder. */
export const isClaudeAgent: (title: string) => boolean =
  memoizeTitleClassification(computeIsClaudeAgent)

export function isClaudeManagementTitle(title: string): boolean {
  return CLAUDE_MANAGEMENT_TITLE_RE.test(title)
}

function computeAgentLabel(title: string): string | null {
  if (isClaudeManagementTitle(title)) {
    return null
  }
  // The native OpenCode marker owns the whole title; names/glyphs in its session text cannot rebrand it.
  if (isOpenCodeNativeTitle(title)) {
    return 'OpenCode'
  }
  // Claude’s prefix identifies the agent; task-text CLI mentions do not.
  if (
    title.startsWith(`${CLAUDE_IDLE} `) ||
    title === CLAUDE_IDLE ||
    title.startsWith('. ') ||
    title.startsWith('* ')
  ) {
    return 'Claude Code'
  }
  // Why before Gemini: see isDshTerminalTitle — the two share the `✦` glyph.
  if (isDshTerminalTitle(title)) {
    return 'DeepSeek Harness'
  }
  if (isQoderTerminalTitle(title)) {
    return title.includes('Qoder CLI CN') ? 'Qoder CLI CN' : 'Qoder CLI'
  }
  // Why: the DSB matcher distinguishes native prefixes from glyphs inside task text.
  if (isDeepSeekBuildTerminalTitle(title)) {
    return 'DeepSeek Build'
  }
  if (isGeminiTerminalTitle(title)) {
    return 'Gemini CLI'
  }
  // Pi-compatible synthetic identities must win over generic braille heuristics.
  const piCompatibleSyntheticAgentLabel = getPiCompatibleSyntheticAgentLabel(title)
  if (piCompatibleSyntheticAgentLabel) {
    return piCompatibleSyntheticAgentLabel
  }
  // Pi working titles use braille too; check Pi before Claude’s fallback.
  if (isPiAgentTitle(title)) {
    return 'Pi'
  }
  // Prefer explicit agent tokens over Claude’s generic spinner; token boundaries exclude similarly named workspace paths.
  if (titleHasAgentName(title, 'codex')) {
    return 'Codex'
  }
  if (titleHasAgentName(title, 'openclaude')) {
    return 'OpenClaude'
  }
  if (titleHasAgentName(title, 'copilot')) {
    return 'GitHub Copilot'
  }
  if (titleHasAgentName(title, 'grok')) {
    return 'Grok'
  }
  if (titleHasAgentName(title, 'devin')) {
    return 'Devin'
  }
  if (titleHasAgentName(title, 'jcode')) {
    return 'Jcode'
  }
  if (titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)) {
    return 'Antigravity'
  }
  if (titleHasAgentName(title, 'opencode2')) {
    return 'OpenCode 2'
  }
  if (titleHasAgentName(title, 'opencode')) {
    return 'OpenCode'
  }
  if (titleHasAgentName(title, 'mimo')) {
    return 'MiMo Code'
  }
  if (titleHasAgentName(title, 'aider')) {
    return 'Aider'
  }
  // Use Cursor’s closed title set before Claude’s braille fallback; ordinary cursor mentions are not identity.
  if (isCursorAgentTitle(title)) {
    return 'Cursor'
  }
  // Match synthesized Droid before Claude’s braille fallback; token boundaries exclude Android text.
  if (DROID_AGENT_NAME_RE.test(title)) {
    return 'Droid'
  }
  // Match synthesized Hermes before Claude’s braille fallback.
  if (HERMES_AGENT_NAME_RE.test(title)) {
    return 'Hermes'
  }
  if (isClaudeAgent(title)) {
    return 'Claude Code'
  }

  return null
}

/** Pure in `title` — memoized so repeated selector reads skip the regex ladder. */
export const getAgentLabel: (title: string) => string | null =
  memoizeTitleClassification(computeAgentLabel)

const TITLE_LABEL_TO_AGENT: Partial<Record<string, TerminalAgent>> = {
  'DeepSeek Harness': 'dsh',
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
  'Qoder CLI': 'qoder',
  'Qoder CLI CN': 'qoder-cn',
  'Qoder CLI China': 'qoder-cn',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Devin: 'devin',
  Jcode: 'jcode',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  'OpenCode 2': 'opencode2',
  'MiMo Code': 'mimo-code',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  'DeepSeek Build': 'dsb',
  Pi: 'pi',
  OMP: 'omp'
}

function hasGenericClaudeStatusPrefix(title: string): boolean {
  return (
    containsAgentSpinnerGlyph(title) ||
    title.startsWith('✳ ') ||
    title === '✳' ||
    title.startsWith('. ') ||
    title.startsWith('* ')
  )
}

export { isClaudeIdentityFrameTitle } from './agent-title-core'

function isGenericClaudeStatusClaim(title: string, titleAgent: TerminalAgent | null): boolean {
  return (
    titleAgent === 'claude' &&
    hasGenericClaudeStatusPrefix(title) &&
    !titleHasAgentName(title, 'claude')
  )
}

export function resolveTerminalTitleAgentType(title: string): TerminalAgent | null {
  const label = getAgentLabel(title)
  const parsed = label ? (TITLE_LABEL_TO_AGENT[label] ?? null) : null
  return resolveCanonicalPaneAgentIdentity({
    title,
    // Preserve this public parser’s legacy fallback; pane-identity consumers enforce the canonical resolver’s fence on raw titles.
    uncoveredFallback: { agent: parsed, titleOnly: false }
  }).agent
}

/** Treat bare Claude-style prefixes as activity only; explicit identity requires a Claude Code name, not a task/workspace spinner. */
function computeExplicitTerminalTitleAgentType(title: string): TerminalAgent | null {
  const titleAgent = resolveTerminalTitleAgentType(title)
  if (isGenericClaudeStatusClaim(title, titleAgent)) {
    return null
  }
  return titleAgent
}

/** Pure in `title` — memoized so repeated selector reads skip the canonical/title parse. */
export const resolveExplicitTerminalTitleAgentType: (title: string) => TerminalAgent | null =
  memoizeTitleClassification(computeExplicitTerminalTitleAgentType)
