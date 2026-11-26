// Session-level facts for the map's info strip. Derived from the frozen map, so
// desktop and mobile read the same numbers.

import type { AgentMap, AgentMapSessionSummary } from './agent-session-map-model'

export function agentMapSessionSummary(map: AgentMap): AgentMapSessionSummary {
  const files = new Set<string>()
  let toolCallCount = 0
  let lastPromptText: string | undefined
  let lastPromptTs = -1
  for (const node of map.nodes) {
    toolCallCount += node.toolCalls.length
    for (const path of node.filesTouched) {
      files.add(path)
    }
    const promptTs = node.lastPromptTs
    if (node.lastPromptText !== undefined && promptTs !== undefined && promptTs > lastPromptTs) {
      lastPromptTs = promptTs
      lastPromptText = node.lastPromptText
    }
  }
  return {
    agentCount: map.nodes.length,
    toolCallCount,
    filesTouched: [...files],
    ...(lastPromptText === undefined ? {} : { lastPromptText })
  }
}
