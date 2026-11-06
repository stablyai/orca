import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import {
  classifySlotLine,
  compareSlotLines,
  slotLineAt,
  type SlotLineSignal
} from './worktree-card-slot-signal'

export type SlotAgentLine = {
  agent: DashboardAgentRow
  dotState: AgentDotState
  signal: SlotLineSignal
}

export type SlotAgentSignals = {
  /** Lead agents, most urgent first by their own and their subagents' state. */
  rootLines: SlotAgentLine[]
  childrenByParentPaneKey: ReadonlyMap<string, DashboardAgentRow[]>
  lineByPaneKey: ReadonlyMap<string, SlotAgentLine>
  /** The most urgent of an agent and its subagents; a folded lead reports this. */
  rolledByPaneKey: ReadonlyMap<string, SlotLineSignal>
  /** Every agent's own signal, subagents included. */
  allSignals: SlotLineSignal[]
}

const EXCEPTION_KINDS: ReadonlySet<SlotLineSignal['kind']> = new Set([
  'needs',
  'failed',
  'unread',
  'working'
])

/** `unread[i]` is the acknowledgement-based unread flag for `agents[i]` (`selectAgentRowsUnread`). */
export function buildSlotAgentSignals(
  agents: readonly DashboardAgentRow[],
  unread: readonly boolean[]
): SlotAgentSignals {
  const lineByPaneKey = new Map<string, SlotAgentLine>()
  agents.forEach((agent, index) => {
    const { presentation, dotStateOverride } = resolveRowProgramStatus(agent)
    const dotState = dotStateOverride ?? agentRowDisplayDotState(agent)
    const kind = classifySlotLine({
      dotState,
      needsAttention: Boolean(presentation.attention),
      unreadCompletion: unread[index] ?? false
    })
    lineByPaneKey.set(agent.paneKey, {
      agent,
      dotState,
      signal: { kind, at: slotLineAt(agent, kind), monitoring: dotState === 'monitoring' }
    })
  })

  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree([...agents])
  const rolledByPaneKey = new Map<string, SlotLineSignal>()
  const visiting = new Set<string>()
  const rolled = (paneKey: string): SlotLineSignal | null => {
    const cached = rolledByPaneKey.get(paneKey)
    if (cached) {
      return cached
    }
    const own = lineByPaneKey.get(paneKey)?.signal ?? null
    // Lineage metadata may cycle; a pane never counts its own subtree twice.
    if (!own || visiting.has(paneKey)) {
      return own
    }
    visiting.add(paneKey)
    let best = own
    for (const child of childrenByParentPaneKey.get(paneKey) ?? []) {
      const childSignal = rolled(child.paneKey)
      if (
        childSignal &&
        EXCEPTION_KINDS.has(childSignal.kind) &&
        // Only a more urgent state takes over; the lead keeps its own time for the same state.
        compareSlotLines({ kind: childSignal.kind, at: null }, { kind: best.kind, at: null }) < 0
      ) {
        best = childSignal
      }
    }
    visiting.delete(paneKey)
    rolledByPaneKey.set(paneKey, best)
    return best
  }
  for (const agent of agents) {
    rolled(agent.paneKey)
  }

  const rootLines = rootRows
    .map((agent) => lineByPaneKey.get(agent.paneKey))
    .filter((line): line is SlotAgentLine => line !== undefined)
    .sort((a, b) =>
      compareSlotLines(
        rolledByPaneKey.get(a.agent.paneKey) ?? a.signal,
        rolledByPaneKey.get(b.agent.paneKey) ?? b.signal
      )
    )
  return {
    rootLines,
    childrenByParentPaneKey,
    lineByPaneKey,
    rolledByPaneKey,
    allSignals: [...lineByPaneKey.values()].map((line) => line.signal)
  }
}
