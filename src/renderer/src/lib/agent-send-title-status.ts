import type { AgentStatus } from './agent-status'
import { classifyTitleActivity, resolveTitleActivityLabel } from '@/lib/pane-agent-evidence'

const EXPLICIT_IDLE_SEND_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i
const CLAUDE_IDLE_PREFIX = '\u2733'
const GEMINI_IDLE_PREFIX = '\u25c7'
const PI_IDLE_PREFIX = '\u03c0 - '

export function detectAgentSendTitleStatus(title: string | null | undefined): AgentStatus | null {
  if (!title || resolveTitleActivityLabel(title) === null) {
    return null
  }

  const status = classifyTitleActivity(title)
  if (status !== 'idle') {
    return status
  }

  // Why: selected-target sends are immediate. A bare agent name proves identity,
  // but not that the CLI is ready for submitted input yet.
  return isExplicitIdleSendTitle(title) ? status : null
}

function isExplicitIdleSendTitle(title: string): boolean {
  return (
    EXPLICIT_IDLE_SEND_TITLE_RE.test(title) ||
    title.startsWith(CLAUDE_IDLE_PREFIX) ||
    title.startsWith('* ') ||
    title.includes(GEMINI_IDLE_PREFIX) ||
    title.startsWith(PI_IDLE_PREFIX)
  )
}
