// Tool calls grouped per name as of one moment, for the chip line under a node.
// Zoetrope parity: `bash ×5`, ticking while one runs, ✓/✗ as they settle.

import type { AgentMapToolCall } from './agent-session-map-model'

export type AgentMapToolChip = {
  name: string
  /** Calls started at or before `ts`. */
  count: number
  running: number
  completed: number
  failed: number
}

export function agentMapToolChipsAt(
  toolCalls: readonly AgentMapToolCall[],
  ts: number
): AgentMapToolChip[] {
  const byName = new Map<string, AgentMapToolChip>()
  for (const call of toolCalls) {
    if (call.startTs > ts) {
      continue
    }
    let chip = byName.get(call.name)
    if (!chip) {
      chip = { name: call.name, count: 0, running: 0, completed: 0, failed: 0 }
      byName.set(call.name, chip)
    }
    chip.count += 1
    // `state` is the latched final state; at `ts` a call is running until its endTs.
    const ended = call.endTs !== undefined && call.endTs <= ts
    if (!ended) {
      chip.running += 1
    } else if (call.state === 'completed') {
      chip.completed += 1
    } else if (call.state === 'failed') {
      chip.failed += 1
    }
  }
  return [...byName.values()]
}
