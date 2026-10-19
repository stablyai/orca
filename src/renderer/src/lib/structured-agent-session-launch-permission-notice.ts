import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { TuiAgent } from '../../../shared/tui-agent'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/native-chat-permission-mode-labels'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'

/** Why a paired host may not run this chat: it would not apply the permission mode asked for. */
export function hostPermissionRefusedText(
  agentLabel: string,
  kind: 'refused' | 'unverified',
  requested: unknown = useAppStore.getState().settings?.nativeChatPermissionMode
): string {
  return kind === 'unverified'
    ? translate(
        'components.native-chat.hostPermission.unverified',
        "Orca couldn't confirm this host applies chat permissions. Reconnect to it to send."
      )
    : translate(
        'components.native-chat.hostPermission.outdatedHost',
        'This host runs an older Orca that ignores chat permissions, so {{value0}} would run here without asking. Update Orca on this host to use {{value1}}.',
        {
          value0: agentLabel,
          value1: nativeChatPermissionModeLabel(
            isAgentChatPermissionMode(requested) ? requested : 'ask'
          )
        }
      )
}

export function notifyHostPermissionRefused(agent: TuiAgent, kind: 'refused' | 'unverified'): void {
  const agentLabel = structuredAgentLabel(agent)
  toast.error(
    translate(
      'components.native-chat.hostPermission.launchRefused',
      'Orca did not start a {{value0}} chat',
      { value0: agentLabel }
    ),
    { description: hostPermissionRefusedText(agentLabel, kind) }
  )
}
