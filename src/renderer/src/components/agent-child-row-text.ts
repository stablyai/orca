import type { AgentChildRowModel } from '../../../shared/agent-child-row-model'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { agentStateLabel } from '@/components/AgentStateDot'
import { backgroundTaskStateReason } from '@/components/native-chat/background-task-roster'
import { translate } from '@/i18n/i18n'
import { agentNoUpdateLabel } from '@/lib/agent-row-decay-state'
import { formatAgentToolPreview } from '@/lib/agent-row-tool-preview'

export type AgentChildRowText = {
  /** Leads the line; kept when the row truncates. */
  lead: string
  /** Follows the separator; '' when there is nothing more to say. */
  trail: string
}

/** How long this child has been silent, on the reader's clock the model measured it on. */
export function agentChildRowNoUpdateLabel(row: AgentChildRowModel, now: number): string {
  return agentNoUpdateLabel({ updatedAt: row.recencyAt }, now)
}

/** The words for a row's detail, reusing the phrasing a CLI agent row uses for the same fact. */
export function agentChildRowDetailText(row: AgentChildRowModel, now: number): string {
  const detail = row.detail
  if (!detail) {
    return ''
  }
  switch (detail.kind) {
    case 'operation':
      return formatAgentToolPreview(
        { toolName: detail.toolName, toolInput: detail.input },
        'working'
      )
    case 'monitoring':
      return agentStateLabel('monitoring')
    case 'message':
      return detail.text
    case 'ended':
      return translate('components.agentChildRow.ended', 'Ended')
    case 'no-update':
      return agentChildRowNoUpdateLabel(row, now)
    case 'role':
      return formatAgentTypeLabel(detail.agentType)
    case 'reason':
      return backgroundTaskStateReason(detail.state) ?? ''
  }
}

/** The line beneath a full-width row: what the child said, or that it ended; '' otherwise. */
export function agentChildRowMessageLine(row: AgentChildRowModel): string {
  if (row.detail?.kind === 'message') {
    return row.detail.text
  }
  return row.detail?.kind === 'ended' ? translate('components.agentChildRow.ended', 'Ended') : ''
}

/** The row's name, or its state when the child reported none. */
export function agentChildRowName(row: AgentChildRowModel): string {
  return row.name.trim() || agentStateLabel(row.displayState)
}

export function agentChildRowText(row: AgentChildRowModel, now: number): AgentChildRowText {
  const name = agentChildRowName(row)
  const detail = agentChildRowDetailText(row, now)
  // Why: a monitoring row leads with its state so truncation keeps passive distinct from active.
  if (row.displayState === 'monitoring' && detail) {
    return { lead: detail, trail: detail === name ? '' : name }
  }
  return { lead: name, trail: detail }
}
