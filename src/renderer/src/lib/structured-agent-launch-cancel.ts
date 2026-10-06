import { discardStructuredAgentSessionLaunchOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { abandonStructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { clearStructuredAgentLaunchDraft } from './structured-agent-session-launch-draft'
import {
  getStructuredLaunchStateBySessionId,
  markStructuredAgentSessionLaunchCancelled,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

export function cancelStructuredAgentLaunch(worktreeId: string, sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return false
  }
  markStructuredAgentSessionLaunchCancelled(worktreeId, sessionId, state.intent.executionHostId)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  clearStructuredAgentLaunchDraft(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}
