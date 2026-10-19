import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentRowState } from '../../../shared/agent-row-decay-state'
import { isProgramStatusRow } from './program-status/row'

type ToolPreviewEntry = Pick<AgentStatusEntry, 'toolName' | 'toolInput'> &
  Partial<Pick<AgentStatusEntry, 'agentType' | 'programStatus' | 'observation'>>

/**
 * States whose cached tool fields describe live work: 'working' names the tool the agent is
 * running, 'waiting' names the tool a permission request is blocked on. Tool fields outlive
 * the turn that set them, so on any other state they read as work still in flight.
 *
 * Shared because three surfaces render this line — the sidebar's compact row, the dashboard
 * row, and the activity thread — and a rule that only two of them relax is a rule that lies.
 */
export function showsAgentToolPreview(state: AgentRowState | null | undefined): boolean {
  return state === 'working' || state === 'waiting'
}

/**
 * The input line a row shows. Alone it is a real agent's orphaned tool argument, so only an OSC 7501
 * program's message — reported as input with no tool to name — stands without a tool name.
 */
export function agentRowToolInput(
  entry: ToolPreviewEntry,
  state: AgentRowState | null | undefined
): string {
  if (!showsAgentToolPreview(state)) {
    return ''
  }
  const toolInput = entry.toolInput?.trim() ?? ''
  return entry.toolName?.trim() || isProgramStatusRow(entry) ? toolInput : ''
}

/** One-line `tool: input` preview (or a program's bare message), or '' when there is nothing. */
export function formatAgentToolPreview(
  entry: ToolPreviewEntry,
  state: AgentRowState | null | undefined
): string {
  if (!showsAgentToolPreview(state)) {
    return ''
  }
  const toolName = entry.toolName?.trim() ?? ''
  const toolInput = agentRowToolInput(entry, state)
  if (toolName && toolInput) {
    return `${toolName}: ${toolInput}`
  }
  return toolName || toolInput
}
