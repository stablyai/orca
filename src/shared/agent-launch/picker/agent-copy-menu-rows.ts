import type { AgentCopy } from '../catalog/agent-copies'
import type { TuiAgent } from '../catalog/tui-agent'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'

/** A copy opens on each surface its agent opens on: a chat where the agent's row offers one, a CLI
 *  wherever the agent is installed. */
export function agentCopyMenuRows(
  rows: readonly NewTabAgentMenuRow[],
  copies: readonly AgentCopy[],
  detected: readonly TuiAgent[] | null
): NewTabAgentMenuRow[] {
  return copies.flatMap((copy) => {
    const named = { id: copy.id, name: copy.name }
    const base = rows.filter((row) => row.agent === copy.agent)
    const chat = base.find(
      (row) => row.kind === 'chat' || (row.kind === 'cli' && row.chat === true)
    )
    const cli =
      base.some((row) => row.kind === 'cli' || row.kind === 'terminal') ||
      detected?.includes(copy.agent) === true
    const executionHostId = base[0]?.executionHostId
    const host = executionHostId ? { executionHostId } : {}
    return [
      ...(chat ? [{ kind: 'chat' as const, agent: copy.agent, ...host, copy: named }] : []),
      ...(cli
        ? [
            chat || base.length > 0
              ? { kind: 'cli' as const, agent: copy.agent, ...host, copy: named }
              : { kind: 'terminal' as const, agent: copy.agent, copy: named }
          ]
        : [])
    ]
  })
}
