import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { hasStructuredAgentLaunchCancellationTombstonePersisted } from './structured-agent-session-launch-persistence'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'

/** The host's create proof belongs to the existing reader until its tab closes. */
export function publishStructuredAgentSessionCreateHydration(
  intent: StructuredAgentSessionLaunchIntent,
  page: AgentSessionHistoryPage,
  fence: number
): void {
  if (hasStructuredAgentLaunchCancellationTombstonePersisted(intent.sessionId)) {
    return
  }
  getStructuredAgentSessionReadOwner(intent.sessionId, intent.target).publishCreated(page)
  noteStructuredAgentSessionFence(intent.sessionId, fence)
}
