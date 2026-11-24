import type { AgentStatusEntry } from '../contracts/agent-status-types'
import { agentStopDisplayStatus } from '../lifecycle/agent-stop-display-status'
import {
  programStatusAttentionLine,
  type ProgramStatusPresentation
} from '../../program-status/presentation'
import { agentNoUpdateLabel, type AgentRowState } from './agent-row-decay-state'
import { formatAgentToolPreview } from './agent-row-tool-preview'
import { agentVerdictStatusLine } from './agent-verdict-status-line'

export type CompactAgentStatusEntry = Parameters<typeof agentVerdictStatusLine>[0] &
  Parameters<typeof formatAgentToolPreview>[0] &
  Pick<AgentStatusEntry, 'updatedAt'> &
  Partial<Pick<AgentStatusEntry, 'evidenceObservedAt' | 'mainAgent' | 'workingMode'>>

/** What the agent itself reported, as every compact row reads it (a sidebar card's, a bot row's on
 *  either app); null when it has said nothing yet. */
export function compactAgentStatusLine(args: {
  entry: CompactAgentStatusEntry
  state: AgentRowState
  presentation: ProgramStatusPresentation
  now: number
  labels: { stopping: string; monitoring: string }
  lastAssistantMessage?: string
}): string | null {
  const { entry, state, presentation } = args
  // Program-reported blocks need user attention before other row details.
  if (presentation.attention) {
    return programStatusAttentionLine(presentation.attention)
  }
  const verdictLine = agentVerdictStatusLine(entry)
  if (verdictLine) {
    return verdictLine
  }
  // Silence proves only time without updates; do not infer what the pane is doing.
  if (state === 'unverifiable') {
    return agentNoUpdateLabel(entry, args.now)
  }
  const stopping = agentStopDisplayStatus({
    working: state === 'working',
    hostStopping: entry.mainAgent?.stopping === true
  })
  if (stopping === 'stopping') {
    return args.labels.stopping
  }
  // Why: the lead turn is over in monitoring, so its last tool line is stale; name the state instead.
  if (state === 'working' && entry.workingMode === 'monitoring') {
    return args.labels.monitoring
  }
  const toolPreview = formatAgentToolPreview(entry, state)
  if (toolPreview) {
    return toolPreview
  }
  if (presentation.message) {
    return presentation.message
  }
  return (args.lastAssistantMessage ?? entry.lastAssistantMessage?.trim()) || null
}
