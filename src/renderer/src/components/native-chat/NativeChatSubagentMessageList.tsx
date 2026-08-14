import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { codexLiveSubagents } from '../../../../shared/codex-subagent-items'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
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
    | { structuredSessionId: string; target: RuntimeClientTarget }
}): React.JSX.Element {
  const { agent } = messageListProps.session
  const sources = useMemo<AgentSubagentSource[]>(() => {
    if ('structuredSessionId' in subagents) {
      return [
        {
          key: subagents.structuredSessionId,
          identity: agent,
          agent,
          sessionId: subagents.structuredSessionId,
          ...subagents,
          transcriptPath: null,
          runtimeEnvironmentId:
            subagents.target.kind === 'environment' ? subagents.target.environmentId : null,
          liveSubagents:
            agent === 'codex' ? codexLiveSubagents(messageListProps.session.messages) : [],
          working: messageListProps.isWorking
        }
      ]
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
  }, [
    agent,
    messageListProps.isWorking,
    messageListProps.session.sessionId,
    messageListProps.session.messages,
    subagents
  ])
  return (
    <AgentSubagentProvider sources={sources}>
      <NativeChatMessageList {...messageListProps} subagentSourceKey={sources[0]?.key} />
    </AgentSubagentProvider>
  )
}
