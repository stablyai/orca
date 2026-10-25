import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentRowState } from '../../../shared/agent-row-decay-state'
import { isProgramStatusRow } from './program-status/row'

type ToolPreviewEntry = Pick<AgentStatusEntry, 'toolName' | 'toolInput'> &
  Partial<Pick<AgentStatusEntry, 'agentType' | 'programStatus' | 'observation'>>

/** Cached tool fields describe live work only in working/permission-wait states; share this gate across sidebar, dashboard and activity rows. */
export function showsAgentToolPreview(state: AgentRowState | null | undefined): boolean {
  return state === 'working' || state === 'waiting'
}

/** Only OSC 7501 programs may show bare input as their message; an agent’s orphaned tool argument needs a tool name. */
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
