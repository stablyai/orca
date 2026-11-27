import { toast } from 'sonner'
import type { Translate } from '@/i18n/use-translate'
import { agentChatPermissionModes } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import type { AgentPermissionChoice } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { agentPermissionChoiceLabel } from '../../../agent/launch-settings/agent-permission-choice-label'

/** Confirms a permission read out of saved Arguments, naming chats only when they offer that mode. */
export function toastLiftedAgentPermission(args: {
  agent: TuiAgent
  label: string
  choice: AgentPermissionChoice
  chatPermissionsSupported: boolean
  t: Translate
}): void {
  const { agent, label, choice, t } = args
  const reachesChats =
    args.chatPermissionsSupported &&
    agentChatPermissionModes(agent)?.modes.some((mode) => mode === choice) === true
  const values = { agent: label, mode: agentPermissionChoiceLabel(choice, label, t) }
  toast.success(
    reachesChats
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
