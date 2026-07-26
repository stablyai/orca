import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName
} from './agent-name-token-match'
import { isCursorAgentTitle } from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  getPiCompatibleSyntheticAgentLabel,
  isLegacyPiCompatibleTitle
} from './pi-compatible-synthetic-title'
import { hasLeadingExplicitAgentTitleIdentity } from './explicit-agent-title-identity'
import type { TuiAgent } from './types'

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
  // Why: Gemini OSC glyphs are stronger evidence than any cwd/session text.
  if (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE)
  ) {
    return true
  }
  // Why: Pi/OMP titles include cwd/session text; substring matching made
  // paths like "gemini-project" masquerade as Gemini CLI.
  if (isPiAgentTitle(title)) {
    return false
  }
  return titleHasAgentName(title, 'gemini')
}

export function isPiTerminalTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title) && !containsBrailleSpinner(title)
}

// Why: Grok Build's working OSC titles use a fixed frame shape —
// "spinner - <rotating phrase> - grok" — so every frame is a distinct title
// that flips tab and sidebar labels. Require BOTH the post-spinner " - "
// delimiter and the trailing identity " - grok" so Claude/Codex task text
// like "⠋ fix the flaky suite - grok" or "⠋ wire up grok" is not mislabeled.
// Spinner marks working; no-spinner session titles ("Fix the auth bug - grok")
// pass through. The bare "spinner + grok" branch keeps our own collapsed
// label idempotent under re-normalization.
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

/**
 * Returns true when the terminal title matches Claude Code's title conventions.
 * Used to scope prompt-cache-timer behavior to Claude sessions only — other
 * agents have different (or no) caching semantics.
 */
export function isClaudeAgent(title: string): boolean {
  if (!title || isClaudeManagementTitle(title) || isOpenCodeNativeTitle(title)) {
    return false
  }
  const lower = title.toLowerCase()

  // Why: Claude Code titles are prefixed with status indicators (✳, ". ", "* ",
  // braille spinners) followed by the task description. The task text can
  // legitimately mention other agents, so Claude-specific prefixes must win.
  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return true
  }
  // Why: ". " (working) and "* " (idle) are Claude Code title conventions.
  // Other supported agents do not use them, and rejecting titles that mention
  // another agent in the task text caused false negatives for real Claude tabs.
  if (title.startsWith('. ') || title.startsWith('* ')) {
    return true
  }
  if (containsBrailleSpinner(title)) {
    // Why: named non-Claude agents carry braille spinners too. Gate Cursor by its
    // identity title, not the token, so a Claude title mentioning a cursor stays Claude.
    return !isCursorAgentTitle(title) && !lower.includes('openclaude')
  }
  // Why: permission/action-required Claude titles can omit the usual prefixes.
  // Token-match so cwd/worktree titles like "claude-scratch" do not become
  // Claude tabs, while task text that merely mentions Claude still stays out.
  const trimmedTitle = title.trimStart()
  if (
    trimmedTitle.toLowerCase().startsWith('claude') &&
    titleHasAgentName(trimmedTitle, 'claude')
  ) {
    return true
  }

  return false
}

export function isClaudeManagementTitle(title: string): boolean {
  return CLAUDE_MANAGEMENT_TITLE_RE.test(title)
}

export function getAgentLabel(title: string): string | null {
  if (isClaudeManagementTitle(title)) {
    return null
  }
  // Why: the native marker owns the whole title; its session text may name or
  // include status glyphs from other agents without changing OpenCode identity.
  if (isOpenCodeNativeTitle(title)) {
    return 'OpenCode'
  }
  // Why: Claude Code title text is often the task title. If that task mentions
  // another CLI, the Claude-specific prefix is the identity signal, not the words.
  if (
    title.startsWith(`${CLAUDE_IDLE} `) ||
    title === CLAUDE_IDLE ||
    title.startsWith('. ') ||
    title.startsWith('* ')
  ) {
    return 'Claude Code'
  }
  if (isGeminiTerminalTitle(title)) {
    return 'Gemini CLI'
  }
  // Why: Pi-compatible synthetic titles can carry braille spinners, which the
  // generic agent-title heuristics would otherwise claim first.
  const piCompatibleSyntheticAgentLabel = getPiCompatibleSyntheticAgentLabel(title)
  if (piCompatibleSyntheticAgentLabel) {
    return piCompatibleSyntheticAgentLabel
  }
  // Why: Pi working titles include a braille spinner prefix, which would be
  // mistaken for Claude Code if we checked `isClaudeAgent` first.
  if (isPiAgentTitle(title)) {
    return 'Pi'
  }
  // Why: Codex/OpenCode/Aider can also use braille spinner prefixes while
  // working. Prefer explicit name matches before Claude's generic spinner
  // heuristic so mixed-agent hovercards stay truthful. Token-match (not
  // substring) so cwd/worktree titles like "opencode-blinker" don't mint a
  // false agent identity.
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
  if (titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)) {
    return 'Antigravity'
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
  // Why: `cursor` is ordinary editor vocabulary, not identity. Match Cursor's closed
  // title set (mirrors @cursor routing), before `isClaudeAgent` claims the braille frame.
  if (isCursorAgentTitle(title)) {
    return 'Cursor'
  }
  // Why: synthesized "⠋ Droid" working title needs to be matched before Claude's braille heuristic.
  // Token matching avoids labeling ordinary Android terminal titles as Droid.
  if (DROID_AGENT_NAME_RE.test(title)) {
    return 'Droid'
  }
  // Why: synthesized "⠋ Hermes" working titles need to be matched before
  // Claude's generic braille-spinner heuristic.
  if (HERMES_AGENT_NAME_RE.test(title)) {
    return 'Hermes'
  }
  if (isClaudeAgent(title)) {
    return 'Claude Code'
  }

  return null
}

// Maps getAgentLabel()'s product labels to TuiAgent ids — the fallback for
// agents whose foreground PROCESS name isn't self-identifying (Claude Code runs
// as `node`, but its "✳ Claude Code" title resolves here). Agents whose process
// name already matches (codex, etc.) never reach this path.
const TITLE_LABEL_TO_AGENT: Partial<Record<string, TuiAgent>> = {
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Devin: 'devin',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  'MiMo Code': 'mimo-code',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  Pi: 'pi',
  OMP: 'omp'
}

export function resolveTerminalTitleAgentType(title: string): TuiAgent | null {
  const label = getAgentLabel(title)
  return label ? (TITLE_LABEL_TO_AGENT[label] ?? null) : null
}

/**
 * Resolve identity only when a provider owns the title frame. Agent names
 * inside task text are activity content, not evidence that the pane changed
 * providers.
 */
export function resolveExplicitTerminalTitleAgentType(title: string): TuiAgent | null {
  const titleAgent = resolveTerminalTitleAgentType(title)
  if (!titleAgent) {
    return null
  }
  if (
    isOpenCodeNativeTitle(title) ||
    isGrokRotatingWorkingTitle(title) ||
    (titleAgent === 'gemini' && /(?:^| \| )\s*[✦⏲◇✋]/u.test(title)) ||
    (titleAgent === 'pi' && isPiAgentTitle(title)) ||
    (titleAgent === 'grok' && !containsBrailleSpinner(title) && /\s-\s+grok\s*$/i.test(title))
  ) {
    return titleAgent
  }
  return hasLeadingExplicitAgentTitleIdentity(title, titleAgent) ? titleAgent : null
}
