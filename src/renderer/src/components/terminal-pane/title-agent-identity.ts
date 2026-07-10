import {
  detectAgentStatusFromTitle,
  isGeminiTerminalTitle,
  isPiTerminalTitle
} from '../../../../shared/agent-detection'
import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAnyLegacyAgentName
} from '../../../../shared/agent-name-token-match'

const EXTRA_TITLE_AGENT_TOKEN_RE =
  /(?<![\w./\\-])(?:cursor-agent|pi)(?:\.(?:exe|cmd|bat|ps1))?(?![\w./\\-])/i

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
  return (
    titleHasAnyLegacyAgentName(title) ||
    AGY_AGENT_NAME_RE.test(title) ||
    DROID_AGENT_NAME_RE.test(title) ||
    HERMES_AGENT_NAME_RE.test(title) ||
    EXTRA_TITLE_AGENT_TOKEN_RE.test(title)
  )
}

export function titleIsInconclusiveNativeDroidTitle(title: string): boolean {
  return /\bDroid\b/i.test(title) && detectAgentStatusFromTitle(title) === null
}
