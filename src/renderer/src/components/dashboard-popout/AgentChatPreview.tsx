import { useMemo } from 'react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { useStructuredAgentSessionRead } from '../native-chat/session/structured/read/use-structured-agent-session-read'
import { projectStructuredAgentSessionMessages } from '../native-chat/conversation/projection/structured-agent-session-message-projection'
import { createNativeChatMessageListProjection } from '../native-chat/conversation/projection/native-chat-message-list-projection'
import { AgentChatTranscript } from './AgentChatTranscript'

export default function AgentChatPreview({
  session,
  agentName,
  className
}: {
  session: NonNullable<DashboardCard['chatSession']>
  agentName: string
  className?: string
}): React.JSX.Element {
  const { state, readCurrent, loadingOlder, loadOlder } = useStructuredAgentSessionRead({
    sessionId: session.sessionId,
    target: session.target,
    isViewed: false,
    observeWorkspaceLinks: false
  })
  const project = useMemo(() => createNativeChatMessageListProjection(), [])
  const messages = useMemo(
    () =>
      project(projectStructuredAgentSessionMessages(state.items, [], state.submissions), {
        items: state.items,
        submissions: state.submissions,
        latestTurn: state.latestTurn
      }).conversation,
    [project, state.items, state.submissions, state.latestTurn]
  )
  return (
    <AgentChatTranscript
      messages={messages}
      agentName={agentName}
      status={state.status}
      current={readCurrent}
      hasOlder={state.hasOlder}
      loadingOlder={loadingOlder}
      loadOlder={() => {
        void loadOlder()
      }}
      className={className}
    />
  )
}
