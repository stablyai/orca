import { agentSessionHostStatusText } from '../messages/notices/agent-session-host-status-text'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import { useTranslate } from '@/i18n/use-translate'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  useNativeChatHostPermissionGate,
  type NativeChatHostPermissionGate
} from './use-native-chat-host-permission-gate'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

/** What holds Send on the chat's host: its permission check, or a stopped WSL distro only Start may boot. */
export function useNativeChatHostSendGate(
  { target, agent }: { target: RuntimeClientTarget; agent: AgentType },
  outage: NativeChatHostOutage | null,
  phase?: AgentSessionStatusSummary['hostExecutionPhase'] | null
): NativeChatHostPermissionGate {
  const t = useTranslate()
  const permission = useNativeChatHostPermissionGate(target, agent, structuredAgentLabel(agent))
  if (phase === 'catching-up') {
    const text = agentSessionHostStatusText('continued-outside-catching-up')
    return {
      sendBlockedReason: text,
      notice: { key: 'history-catch-up', kind: 'host', tone: 'muted', text }
    }
  }
  if (permission.sendBlockedReason !== null || outage?.kind !== 'stopped') {
    return permission
  }
  return {
    ...permission,
    sendBlockedReason: t(
      'components.native-chat.hostOutage.startToSend',
      'Start {{distro}} to send.',
      {
        distro: outage.hostLabel
      }
    )
  }
}
