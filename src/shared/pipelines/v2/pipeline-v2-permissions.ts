import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { agentChatPermissionModes } from '../../agent-launch/permissions/agent-chat-permission-support'
import { AGENT_PERMISSION_CHOICES } from '../../agent-launch/permissions/tui-agent-permission-choice'

export function pipelineV2PermissionChoices(
  agent: TuiAgent,
  surface: 'chat' | 'terminal',
  supportsAutoMode?: boolean
) {
  return AGENT_PERMISSION_CHOICES.filter(
    (choice) =>
      choice === 'own' ||
      (!(choice === 'auto' && supportsAutoMode === false) &&
        surface === 'chat' &&
        agentChatPermissionModes(agent)?.modes.includes(choice) === true)
  )
}
