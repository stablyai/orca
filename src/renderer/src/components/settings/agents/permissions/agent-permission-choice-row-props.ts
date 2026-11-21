import { agentChatPermissionModes } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { savedChatPermissionMode } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentPermissionArgs,
  agentPermissionEnv,
  agentPermissionChoices,
  resolveAgentPermission,
  type AgentPermissionSettings
} from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { agentArgsSetPermission } from '../../../../../../shared/agent-launch/permissions/agent-permission-args'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentPermissionChoiceRow } from '../../../agent/launch-settings/agent-permission-choice-row'

/** The permission choice row on `agent`'s card; none where the host has no typed permissions or
 *  the agent offers a single choice. */
export function buildAgentPermissionChoiceRow(args: {
  agent: TuiAgent
  permissionSettings: AgentPermissionSettings | null
  userArgs: string | undefined
  chatOwnSupported: boolean
  onSelect: AgentPermissionChoiceRow['onSelect']
}): AgentPermissionChoiceRow | undefined {
  const { agent, permissionSettings } = args
  const choices = agentPermissionChoices(agent)
  if (!permissionSettings || choices.length < 2) {
    return undefined
  }
  const resolved = resolveAgentPermission(agent, permissionSettings)
  const chatSupport = agentChatPermissionModes(agent)
  return {
    choices,
    chatOwnSupported: args.chatOwnSupported,
    ...resolved,
    terminalChoice:
      agentPermissionArgs(agent, resolved.choice) ||
      Object.keys(agentPermissionEnv(agent, resolved.choice)).length
        ? resolved.choice
        : 'own',
    chatChoice:
      chatSupport && resolved.choice !== 'own'
        ? savedChatPermissionMode(chatSupport, resolved.choice)
        : null,
    defaultChoice: resolveAgentPermission(agent, {
      agentPermissionDefault: permissionSettings.agentPermissionDefault
    }).choice,
    onSelect: args.onSelect,
    flag: agentPermissionArgs(agent, resolved.choice),
    argsSetPermission: agentArgsSetPermission(agent, args.userArgs)
  }
}
