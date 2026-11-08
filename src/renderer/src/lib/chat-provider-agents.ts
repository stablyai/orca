import { useAppViewExternalStore } from '@/store/retained-views/app-state-view'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import {
  hostStructuredAgentsVersion,
  readHostStructuredAgents,
  subscribeHostStructuredAgents,
  type HostStructuredAgentsStatuses
} from '@/runtime/native-chat/agent-catalogs/host-structured-agents'

const BUILT_IN_CHAT_AGENTS: readonly TuiAgent[] = ['claude', 'codex']

/** Claude and Codex, which every chat host runs, then the other agents a host registered for chat. */
export function chatProviderAgents(
  executionHostId: string,
  statuses: HostStructuredAgentsStatuses
): TuiAgent[] {
  const registered = readHostStructuredAgents(executionHostId, statuses) ?? []
  return [
    ...new Set([
      ...BUILT_IN_CHAT_AGENTS,
      ...registered.map((row) => row.agent).filter((agent) => isTuiAgent(agent))
    ])
  ]
}

export function useHostStructuredAgentsVersion(): number {
  return useAppViewExternalStore(
    subscribeHostStructuredAgents,
    hostStructuredAgentsVersion,
    hostStructuredAgentsVersion
  )
}
