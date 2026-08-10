import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  AgentSubagentProvider,
  type AgentSubagentSource
} from '../agent-subagents/AgentSubagentProvider'
import { NativeChatMessageList } from './NativeChatMessageList'

export function NativeChatSubagentMessageList({
  subagents,
  ...messageListProps
}: React.ComponentProps<typeof NativeChatMessageList> & {
  subagents: readonly [string, string | null, string | null, AgentStatusEntry | undefined]
}): React.JSX.Element {
  const [paneKey, transcriptPath, runtimeEnvironmentId, agentStatus] = subagents
  const { agent } = messageListProps.session
  const sources = useMemo<AgentSubagentSource[]>(
    () => [
      {
        key: 'native-chat',
        identity: agent,
        agent,
        paneKey,
        sessionId: messageListProps.session.sessionId,
        transcriptPath,
        runtimeEnvironmentId,
        target: runtimeEnvironmentId
          ? { kind: 'environment', environmentId: runtimeEnvironmentId }
          : { kind: 'local' },
        liveSubagents: agentStatus?.subagents ?? [],
        working: messageListProps.isWorking
      }
    ],
    [
      agent,
      agentStatus?.subagents,
      messageListProps.isWorking,
      messageListProps.session.sessionId,
      paneKey,
      runtimeEnvironmentId,
      transcriptPath
    ]
  )
  return (
    <AgentSubagentProvider sources={sources}>
      <NativeChatMessageList {...messageListProps} subagentSourceKey="native-chat" />
    </AgentSubagentProvider>
  )
}
