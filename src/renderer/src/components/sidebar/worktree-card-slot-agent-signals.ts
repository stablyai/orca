import type { AgentRowState } from '../../../../shared/agent-status/presentation/agent-row-decay-state'
import type { AgentChildRowModel } from '../../../../shared/agent-status/presentation/agent-child-row-model'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import { classifySlotLine, slotLineAt, type SlotLineSignal } from './worktree-card-slot-signal'

export type SlotAgentLine = {
  agent: DashboardAgentRow
  signal: SlotLineSignal
}

export type SlotAgentSignals = {
  rootCount: number
  lines: SlotAgentLine[]
  allSignals: SlotLineSignal[]
}

/** One agent's dot and slot kind, program-status blocks included; visible lines and collapsed rollups both read this. */
function projectSlotAgentLine(
  agent: {
    state: AgentRowState
    entry: DashboardAgentRow['entry']
    childRow?: Pick<AgentChildRowModel, 'displayState'>
  },
  unreadCompletion: boolean
) {
  const { presentation, dotStateOverride } = resolveRowProgramStatus(agent)
  const dotState = dotStateOverride ?? agentRowDisplayDotState(agent)
  return {
    dotState,
    kind: classifySlotLine({
      dotState,
      needsAttention: Boolean(presentation.attention),
      unreadCompletion
    })
  }
}

/** `unread[i]` is the acknowledgement-based unread flag for `agents[i]` (`selectAgentRowsUnread`). */
export function buildSlotAgentSignals(
  agents: readonly DashboardAgentRow[],
  unread: readonly boolean[]
): SlotAgentSignals {
  const lines = agents.map((agent, index): SlotAgentLine => {
    const { dotState, kind } = projectSlotAgentLine(agent, unread[index] ?? false)
    return {
      agent,
      signal: { kind, at: slotLineAt(agent, kind), monitoring: dotState === 'monitoring' }
    }
  })
  return {
    rootCount: buildAgentRowLineageTree([...agents]).rootRows.length,
    lines,
    allSignals: lines.map((line) => line.signal)
  }
}
