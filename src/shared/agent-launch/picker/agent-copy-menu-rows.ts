import type { AgentCopy } from '../catalog/agent-copies'
import type { TuiAgent } from '../catalog/tui-agent'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'

/** A copy opens wherever its agent opens: its agent's chat and CLI rows, or a terminal when the
 *  agent is installed but listed nowhere else. */
export function agentCopyMenuRows(
  rows: readonly NewTabAgentMenuRow[],
  copies: readonly AgentCopy[],
  detected: readonly TuiAgent[] | null
): NewTabAgentMenuRow[] {
  return copies.flatMap((copy) => {
    const named = { id: copy.id, name: copy.name }
    const base = rows.filter((row) => row.agent === copy.agent && row.kind !== 'chat-unavailable')
    if (base.length > 0) {
      return base.map((row) => ({ ...row, copy: named }))
    }
    return detected?.includes(copy.agent)
      ? [{ kind: 'terminal' as const, agent: copy.agent, copy: named }]
      : []
  })
}
