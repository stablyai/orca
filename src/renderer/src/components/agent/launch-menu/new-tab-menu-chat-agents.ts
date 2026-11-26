// The chat agents the new-tab menu offers on a host: built-ins it can open, then its custom ACP agents.

import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isCustomAcpAgentId } from '../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { nativeChatPreferenceFor } from '../../../../../shared/agent-launch/choices/structured-native-chat-launch-route'
import type { AgentSessionAgentAvailability } from '../../../../../shared/agent-session/agent-discovery/agent-session-agent-availability'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  readHostStructuredAgents,
  type HostStructuredAgentsStatuses
} from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import type { CustomAcpAgentMenuRow } from './new-tab-agent-menu-model'

export function newTabMenuChatAgents(input: {
  /** The workspace runs on this machine. */
  local: boolean
  /** The host's published availability; undefined before it arrives or on hosts without it. */
  published: ReadonlyMap<string, AgentSessionAgentAvailability> | undefined
  hostStatuses: HostStructuredAgentsStatuses
  /** The workspace's host, as the runtime names it. */
  hostKey: string
  settings: Parameters<typeof nativeChatPreferenceFor>[0]
  /** Where custom agents open; undefined offers none (an unresolved host, or a launch they can't take). */
  customAgentsHost: ExecutionHostId | undefined
}): { chatAgents: TuiAgent[]; customAgents: CustomAcpAgentMenuRow[] } {
  const { local, published, hostStatuses, settings } = input
  const roster = published ? [...published.keys()] : undefined
  const localCatalog =
    local && roster
      ? roster
      : readHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, hostStatuses)?.map(({ agent }) => agent)
  const listed = readHostStructuredAgents(input.hostKey, hostStatuses)
  const hostCatalog = roster ?? listed?.map(({ agent }) => agent)
  const chatAgents = [
    ...new Set([
      'claude',
      'codex',
      ...(localCatalog ?? []),
      ...(hostCatalog ?? []),
      ...Object.keys(settings?.nativeChatProviders ?? {})
        .filter(isTuiAgent)
        .filter((agent) => nativeChatPreferenceFor(settings, agent))
    ])
  ].filter(isTuiAgent)
  const host = input.customAgentsHost
  const customAgents = host
    ? (listed ?? []).flatMap(({ agent, label, disabled }): CustomAcpAgentMenuRow[] => {
        const availability = published?.get(agent)
        // A published roster that no longer reports the agent means its host dropped it.
        if (!isCustomAcpAgentId(agent) || disabled || (published && !availability)) {
          return []
        }
        const missing = availability?.chatProgram === 'missing'
        return [
          { agent, label: label ?? agent, executionHostId: host, ...(missing && { missing }) }
        ]
      })
    : []
  return { chatAgents, customAgents }
}
