import { translate } from '@/i18n/i18n'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  useNativeChatHostPermissionGate,
  type NativeChatHostPermissionGate
} from './use-native-chat-host-permission-gate'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

/** What holds Send on the chat's host: its permission check, or a stopped WSL distro only Start may boot. */
export function useNativeChatHostSendGate(
  target: RuntimeClientTarget,
  agent: AgentType,
  outage: NativeChatHostOutage | null
): NativeChatHostPermissionGate {
  const permission = useNativeChatHostPermissionGate(target, agent, structuredAgentLabel(agent))
  if (permission.sendBlockedReason !== null || outage?.kind !== 'stopped') {
    return permission
  }
  return {
    ...permission,
    sendBlockedReason: translate(
      'components.native-chat.hostOutage.startToSend',
      'Start {{distro}} to send.',
      {
        distro: outage.hostLabel
      }
    )
  }
}
