import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { structuredAgentSessionFocusOwner } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { StructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-intent'

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    structuredAgentSessionFocusOwner(intent.target),
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}
