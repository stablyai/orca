import { isNativeChatSupportedAgent } from '../../../../shared/native-chat-agent-support'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { DashboardAgentRow } from './useDashboardData'

/** Chat-mode cards carry the transcript coordinates the inspector reads.
 *  hostKind comes from the map's workspace metadata, not from here. */
export function dashboardCardNativeChatMetadata(
  agentType: string,
  providerSession: DashboardAgentRow['entry']['providerSession'],
  isNativeChatView: boolean
): Pick<DashboardCard, 'viewMode' | 'sessionId' | 'transcriptPath'> {
  if (!isNativeChatView || !isNativeChatSupportedAgent(agentType)) {
    return {}
  }
  return {
    viewMode: 'chat',
    ...(providerSession?.id ? { sessionId: providerSession.id } : {}),
    ...(providerSession?.transcriptPath ? { transcriptPath: providerSession.transcriptPath } : {})
  }
}
