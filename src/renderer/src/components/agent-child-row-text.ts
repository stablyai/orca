import type { AgentChildRowModel } from '../../../shared/agent-child-row-model'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { formatNativeChatDuration } from '../../../shared/native-chat-turn-status'
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
      return agentNoUpdateLabel({ updatedAt: row.recencyAt }, now)
    case 'role':
      return formatAgentTypeLabel(detail.agentType)
    case 'reason':
      return backgroundTaskStateReason(detail.state) ?? ''
  }
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

/** "ended 3m ago" for a settled row whose host reported when; null otherwise. */
export function agentChildRowEndedLabel(row: AgentChildRowModel, now: number): string | null {
  if (!row.settled || row.settledAt === undefined) {
    return null
  }
  return translate('components.agentChildRow.endedAgo', 'ended {{value0}} ago', {
    value0: formatNativeChatDuration((now - row.settledAt) / 1000)
  })
}
