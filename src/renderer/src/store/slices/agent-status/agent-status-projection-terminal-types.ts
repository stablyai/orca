import type { AppState } from '../../types'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

export type TerminalLeafAgentTypes = Readonly<Record<string, AgentType>>
export type TerminalTypeBucket = {
  leaves: Map<string, AgentType>
  output?: TerminalLeafAgentTypes
}
const EMPTY_TYPES: TerminalLeafAgentTypes = Object.freeze({})

export function readTerminalLeafAgentTypes(
  data: AgentStatusProjectionState,
  tabId: string
): TerminalLeafAgentTypes {
  const bucket = data.terminalTypes.get(tabId)
  return bucket ? (bucket.output ??= Object.fromEntries(bucket.leaves)) : EMPTY_TYPES
}

export function stageTerminalLeafAgentTypes(
  data: AgentStatusProjectionState,
  state: AppState,
  changedKeys: ReadonlySet<string>
): () => void {
  const keys = data.inputs
    ? changedKeys
    : new Set([
        ...state.agentStatusByPaneKey.keys(),
        ...Object.keys(state.paneForegroundAgentByPaneKey)
      ])
  const changes: { tabId: string; leafId: string; agent: AgentType | undefined }[] = []
  for (const key of keys) {
    const separator = key.indexOf(':')
    if (separator <= 0) {
      continue
    }
    const tabId = key.slice(0, separator)
    const leafId = key.slice(separator + 1)
    const foreground = state.paneForegroundAgentByPaneKey[key]
    const agent =
      state.agentStatusByPaneKey.get(key)?.agentType ??
      (foreground && !foreground.shellForeground && !foreground.routingRevoked
        ? (foreground.agent ?? undefined)
        : undefined)
    if (data.terminalTypes.get(tabId)?.leaves.get(leafId) !== agent) {
      changes.push({ tabId, leafId, agent })
    }
  }
  return () => {
    for (const { tabId, leafId, agent } of changes) {
      let bucket = data.terminalTypes.get(tabId)
      if (agent) {
        if (!bucket) {
          data.terminalTypes.set(tabId, (bucket = { leaves: new Map() }))
        }
        bucket.leaves.set(leafId, agent)
      } else {
        bucket?.leaves.delete(leafId)
      }
      if (bucket) {
        bucket.output = undefined
        if (!bucket.leaves.size) {
          data.terminalTypes.delete(tabId)
        }
      }
      data.notices.add(`terminal-types\0${tabId}`)
    }
  }
}
