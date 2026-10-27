import { useSyncExternalStore } from 'react'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  hostStructuredAgentsVersion,
  readHostStructuredAgents,
  subscribeHostStructuredAgents,
  type HostStructuredAgentsStatuses
} from '@/runtime/host-structured-agents'

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
  return useSyncExternalStore(
    subscribeHostStructuredAgents,
    hostStructuredAgentsVersion,
    hostStructuredAgentsVersion
  )
}
