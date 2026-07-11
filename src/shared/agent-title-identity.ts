import {
  AGY_AGENT_NAME_RE,
  CLAUDE_IDLE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  containsBrailleSpinner,
  isClaudeManagementTitle,
  isGeminiTerminalTitle,
  isPiAgentTitle,
  titleHasAgentName
} from './agent-title-core'
import { getPiCompatibleSyntheticAgentLabel } from './pi-compatible-synthetic-title'

/**
 * Returns true when the terminal title matches Claude Code's title conventions.
 * Used to scope prompt-cache-timer behavior to Claude sessions only.
 */
export function isClaudeAgent(title: string): boolean {
  if (!title || isClaudeManagementTitle(title)) {
    return false
  }
  const lower = title.toLowerCase()

  // Why: Claude title prefixes are stronger than task text, which can mention
  // other agents without changing the owning CLI.
  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return true
  }
  if (title.startsWith('. ') || title.startsWith('* ')) {
    return true
  }
  if (containsBrailleSpinner(title)) {
    return !lower.includes('cursor') && !lower.includes('openclaude')
  }

  const trimmedTitle = title.trimStart()
  return (
    trimmedTitle.toLowerCase().startsWith('claude') && titleHasAgentName(trimmedTitle, 'claude')
  )
}

export function getAgentLabel(title: string): string | null {
  if (isClaudeManagementTitle(title)) {
    return null
  }
  // Why: Claude task titles can mention another CLI; the prefix is the identity
  // signal, not arbitrary task text.
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
  if (isPiAgentTitle(title)) {
    return 'Pi'
  }

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
  // Why: match explicit names before Claude's generic braille heuristic.
  if (titleHasAgentName(title, 'cursor')) {
    return 'Cursor'
  }
  if (DROID_AGENT_NAME_RE.test(title)) {
    return 'Droid'
  }
  if (HERMES_AGENT_NAME_RE.test(title)) {
    return 'Hermes'
  }
  if (isClaudeAgent(title)) {
    return 'Claude Code'
  }

  return null
}
