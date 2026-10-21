import {
  buildAgentChildRowModels,
  buildLegacyAgentChildRowModels,
  flattenAgentChildRowModels,
  type AgentChildRowContext,
  type AgentChildRowModel
} from './agent-child-row-model'
import { agentChildWorkIsRunning } from './agent-child-work-listing'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { AgentSubagentSnapshot } from './agent-status-types'

function ownsLiveWork(row: AgentChildRowModel): boolean {
  return row.owned.some((owned) => !owned.settled || ownsLiveWork(owned))
}

/** The sidebar and workspace list show running agents, including settled owners of live work. */
export function buildRunningAgentChildRowModels(
  source: {
    children?: readonly AgentChildWorkView[]
    subagents?: readonly AgentSubagentSnapshot[]
  },
  context: AgentChildRowContext
): AgentChildRowModel[] {
  const rows =
    source.children !== undefined
      ? buildAgentChildRowModels(source.children, context)
      : buildLegacyAgentChildRowModels(source.subagents ?? [], context)
  return flattenAgentChildRowModels(rows).filter(
    (row) =>
      row.kind === 'agent' &&
      agentChildWorkIsRunning({ settled: row.settled, ownsLiveWork: ownsLiveWork(row) })
  )
}
