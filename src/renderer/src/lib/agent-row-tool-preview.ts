import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentRowState } from '../../../shared/agent-row-decay-state'
import { isProgramStatusRow } from './program-status/row'
import {
  agentToolPreviewInput,
  formatAgentToolPreviewLine
} from '../../../shared/agent-tool-preview'

type ToolPreviewEntry = Pick<AgentStatusEntry, 'toolName' | 'toolInput'> &
  Partial<Pick<AgentStatusEntry, 'agentType' | 'programStatus' | 'observation'>>

/** Cached tool fields describe live work only in working/permission-wait states; share this gate across sidebar, dashboard and activity rows. */
export function showsAgentToolPreview(state: AgentRowState | null | undefined): boolean {
  return state === 'working' || state === 'waiting'
}

export function agentRowToolInput(
  entry: ToolPreviewEntry,
  state: AgentRowState | null | undefined
): string {
  return showsAgentToolPreview(state) ? agentToolPreviewInput(entry, isProgramStatusRow(entry)) : ''
}

export function formatAgentToolPreview(
  entry: ToolPreviewEntry,
  state: AgentRowState | null | undefined
): string {
  return showsAgentToolPreview(state)
    ? formatAgentToolPreviewLine(entry, isProgramStatusRow(entry))
    : ''
}
