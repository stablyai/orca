import type { AgentPermissionChoice } from '../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { translate } from '../../../i18n/i18n'
import type { Translate } from '../../../i18n/use-translate'
import { nativeChatPermissionModeLabel } from '../../native-chat/session/options/controls/native-chat-permission-mode-labels'

/** Use chat-mode wording; own names the agent when available. */
export function agentPermissionChoiceLabel(
  choice: AgentPermissionChoice,
  agentLabel: string | null,
  t: Translate = translate
): string {
  if (choice !== 'own') {
    return nativeChatPermissionModeLabel(choice, t)
  }
  return agentLabel
    ? t('settings.agents.permissionOwnAgent', "Use {{agent}}'s own settings", {
        agent: agentLabel
      })
    : t('settings.agents.permissionOwnAll', "Agents' own settings")
}
