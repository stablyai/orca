import type { Translate } from '@/i18n/use-translate'
import type { AgentLaunchSettingsMutation } from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { liftAgentPermissionArgs } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-lift'
import { toastLiftedAgentPermission } from './agent-permission-lift-toast'

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
    toastLiftedAgentPermission({
      agent,
      label,
      choice: lifted.choice,
      chatPermissionsSupported: nativeChatPermissionsSupported,
      t
    })
  }
}
