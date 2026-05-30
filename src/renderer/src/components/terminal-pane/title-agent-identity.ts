import {
  detectAgentStatusFromTitle,
  isGeminiTerminalTitle,
  isPiTerminalTitle
} from '../../../../shared/agent-detection'

const TITLE_AGENT_TOKEN_RE =
  /(?<![\w./\\-])(claude|openclaude|codex|gemini|antigravity|agy|opencode|openclaw|aider|copilot|cursor-agent|cursor|droid|hermes|grok|pi)(?![\w./\\-])/i

export function titleHasExplicitAgentIdentity(title: string): boolean {
  if (!title) {
    return false
  }
  if (
    title.startsWith('. ') ||
    title.startsWith('* ') ||
    title.startsWith('\u2733') ||
    isGeminiTerminalTitle(title) ||
    isPiTerminalTitle(title)
  ) {
    return true
  }
  return TITLE_AGENT_TOKEN_RE.test(title)
}

export function titleIsInconclusiveNativeDroidTitle(title: string): boolean {
  return /\bDroid\b/i.test(title) && detectAgentStatusFromTitle(title) === null
}
