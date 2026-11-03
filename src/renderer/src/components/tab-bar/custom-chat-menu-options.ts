import { isCustomAcpAgentId } from '../../../../shared/custom-acp-agent'
import { resolveStructuredNativeChatSupport } from '../../../../shared/structured-native-chat-launch-route'
import type { AgentSessionRegisteredAgent } from '../../../../shared/agent-session/agent-session-registered-agents'
import type { AgentSessionAgentAvailability } from '../../../../shared/agent-session/agent-session-agent-availability'
import type { StructuredNativeChatSupportInput } from '../../../../shared/structured-native-chat-launch-route'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { HostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import {
  readHostStructuredAgents,
  type HostStructuredAgentsStatuses
} from '@/runtime/host-structured-agents'
import type { TabCreateMenuOption } from './tab-create-menu-options'

export function customChatMenuOptions(input: {
  route: StructuredNativeChatSupportInput
  agents: readonly AgentSessionRegisteredAgent[]
  availability: ReadonlyMap<string, AgentSessionAgentAvailability>
  executionHostId: ExecutionHostId
}): TabCreateMenuOption[] {
  const hostStructuredAgents = input.agents.map((row) => row.agent)
  return input.agents.flatMap(({ agent, displayName }) => {
    if (
      !isCustomAcpAgentId(agent) ||
      !resolveStructuredNativeChatSupport({
        ...input.route,
        agent,
        hostStructuredAgents
      }).supported
    ) {
      return []
    }
    const availability = input.availability.get(agent)
    if (availability?.state === 'refused' || availability?.chatProgram !== 'available') {
      return []
    }
    return [
      {
        id: `custom-chat:${agent}`,
        kind: 'custom-chat',
        label: translate(
          'auto.components.tab.bar.QuickLaunchButton.startChat',
          'Start a chat with {{value0}}',
          {
            value0: displayName ?? agent
          }
        ),
        keywords: [agent, displayName ?? agent],
        customChat: { agent, executionHostId: input.executionHostId }
      }
    ]
  })
}

export function hostCustomChatMenuOptions(
  route: StructuredNativeChatSupportInput,
  availability: HostStructuredAgentAvailability | null | undefined,
  statuses: HostStructuredAgentsStatuses
): TabCreateMenuOption[] {
  const host = parseExecutionHostId(route.executionHostId)
  if (!host || availability?.state !== 'received') {
    return []
  }
  return customChatMenuOptions({
    route,
    agents: readHostStructuredAgents(host.id, statuses) ?? [],
    availability: availability.byAgent,
    executionHostId: host.id
  })
}
