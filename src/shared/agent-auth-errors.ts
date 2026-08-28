// Provider-agnostic classifier for "this agent needs the user to (re)authenticate"
// notices. Mirrors codex-auth-errors.ts's pattern-table shape so a future agent
// only adds an entry here instead of a new bespoke matcher.
import { isCodexAuthError } from './codex-auth-errors'
import type { NativeChatTranscriptAgent } from './native-chat-agent-support'

const CLAUDE_AUTH_ERROR_PATTERNS = [
  /run\s+`?\/login`?/i,
  /not logged in/i,
  /please log ?in/i,
  /trusted devices?/i,
  /remote control disconnected/i,
  /enroll this device/i,
  /authentication required/i
]

/** True when `text` (a notice surfaced by the agent, e.g. a transcript system
 *  line or a background rate-limit fetcher error) describes a login/reauth
 *  requirement rather than an unrelated error. Unknown/unhandled agents never
 *  match — silence beats a false "needs login" CTA on a real failure. */
export function isAgentAuthError(
  agent: NativeChatTranscriptAgent | null | undefined,
  text: string | null | undefined
): boolean {
  const message = text?.trim()
  if (!message) {
    return false
  }
  if (agent === 'codex') {
    return isCodexAuthError(message)
  }
  if (agent === 'claude') {
    return CLAUDE_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  }
  return false
}
