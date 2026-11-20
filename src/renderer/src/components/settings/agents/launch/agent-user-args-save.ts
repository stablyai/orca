import { toast } from 'sonner'
import type { Translate } from '@/i18n/use-translate'
import type { AgentLaunchSettingsMutation } from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { agentChatPermissionModes } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { liftAgentPermissionArgs } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-lift'
import { agentPermissionChoiceLabel } from '../../../agent/launch-settings/agent-permission-choice-label'

/** Saves an agent's Arguments and says so when they set its permission mode. */
export async function saveAgentUserArgs(
  context: {
    mutate: (mutation: AgentLaunchSettingsMutation) => Promise<void>
    t: Translate
    nativeChatPermissionsSupported: boolean
  },
  agent: TuiAgent,
  label: string,
  value: string
): Promise<void> {
  const { mutate, t, nativeChatPermissionsSupported } = context
  const lifted = liftAgentPermissionArgs(agent, value)
  await mutate({ type: 'user-arguments', agent, value })
  if (lifted.choice) {
    const chatSupported = nativeChatPermissionsSupported && agentChatPermissionModes(agent)
    const values = { agent: label, mode: agentPermissionChoiceLabel(lifted.choice, label) }
    toast.success(
      chatSupported
        ? t(
            'settings.agents.permissionFromArgs',
            '{{agent}} set to {{mode}} in terminals and new chats.',
            values
          )
        : t(
            'settings.agents.permissionFromArgsTerminals',
            '{{agent}} set to {{mode}} in terminals.',
            values
          )
    )
  }
}
