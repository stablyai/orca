import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'
import type { AntigravityPaneChildState } from './antigravity-pane-state'
export {
  getOrCreateAntigravityPaneState,
  recordAntigravityChildHook,
  type AntigravityPaneChildState
} from './antigravity-pane-state'

export function reconcileAntigravityActiveSubagents(
  pane: AntigravityPaneChildState,
  _now: number
): AgentSubagentSnapshot[] {
  const snapshots: AgentSubagentSnapshot[] = []
  for (const child of pane.children.values()) {
    if (!pane.verifiedChildren.has(child.id)) {
      continue
    }
    snapshots.push({
      id: child.id,
      startedAt: child.startedAt,
      state: child.state,
      model: child.model,
      description: child.description ?? 'Subagent',
      agentType: child.agentType ?? 'subagent',
      toolName: child.toolName,
      toolInput: child.toolInput
    })
  }
  return snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}
