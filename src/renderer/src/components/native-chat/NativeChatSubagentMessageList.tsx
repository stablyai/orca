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
  subagents:
    | readonly [string, string | null, string | null, AgentStatusEntry | undefined]
    | AgentSubagentSource
}): React.JSX.Element {
  const { agent } = messageListProps.session
  const sources = useMemo<AgentSubagentSource[]>(() => {
    if ('key' in subagents) {
      return [subagents]
    }
    const [paneKey, transcriptPath, runtimeEnvironmentId, agentStatus] = subagents
    return [
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
    ]
  }, [agent, messageListProps.isWorking, messageListProps.session.sessionId, subagents])
  return (
    <AgentSubagentProvider sources={sources}>
      <NativeChatMessageList {...messageListProps} subagentSourceKey={sources[0]?.key} />
    </AgentSubagentProvider>
  )
}
