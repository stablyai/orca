// Shared row wording keeps name/state fallbacks and lead/detail order consistent across surfaces.

import type { AgentChildRowModel } from './agent-child-row-model'
import type { AgentChildDisplayState } from '../child-work/agent-status-child-work-display'
import { formatAgentTypeLabel } from './agent-type-label'
import { formatAgentToolPreviewLine } from './agent-tool-preview'
import { agentNoUpdateLabel } from './agent-row-decay-state'
import type { BackgroundTaskSay } from '../../background-task-copy'
import { backgroundTaskStateReason, backgroundTaskStateWord } from '../../background-task-roster'

/** The words each surface supplies: desktop translates them, mobile reads English. */
export type AgentChildRowCopy = {
  stateLabel: (state: AgentChildDisplayState) => string
  ended: () => string
  sayBackgroundTask: BackgroundTaskSay
}

/** The child's reported name with an anonymous agent's id tail; '' when it reported no name. */
function agentChildRowLabel(row: Pick<AgentChildRowModel, 'name' | 'idSuffix'>): string {
  const name = row.name.trim()
  return name && row.idSuffix ? `${name} (${row.idSuffix})` : name
}

/** The row's label, or its state's words when the child reported no name. */
export function agentChildRowName(
  row: Pick<AgentChildRowModel, 'name' | 'displayState' | 'idSuffix'>,
  stateLabel: (state: AgentChildDisplayState) => string
): string {
  const state = stateLabel(row.displayState)
  return agentChildRowLabel(row) || (row.idSuffix ? `${state} (${row.idSuffix})` : state)
}

export function agentChildRowLeadTrail(
  name: string,
  detail: string
): { lead: string; trail: string } {
  // The name leads in every state, monitoring included: its dot glyph already says so.
  return { lead: name, trail: detail === name ? '' : detail }
}

/** Reuse CLI row phrasing for the same child-work facts. */
export function agentChildRowDetailText(
  row: AgentChildRowModel,
  now: number,
  copy: AgentChildRowCopy
): string {
  const detail = row.detail
  if (!detail) {
    return ''
  }
  switch (detail.kind) {
    case 'operation':
      return formatAgentToolPreviewLine(
        { toolName: detail.toolName, toolInput: detail.input },
        false
      )
    case 'monitoring':
      return copy.stateLabel('monitoring')
    case 'message':
      return detail.text
    case 'ended':
      return copy.ended()
    case 'no-update':
      return agentNoUpdateLabel({ updatedAt: row.recencyAt }, now)
    case 'role':
      return formatAgentTypeLabel(detail.agentType)
    case 'reason':
      return (
        backgroundTaskStateReason(detail.state, copy.sayBackgroundTask) ??
        backgroundTaskStateWord(detail.state, copy.sayBackgroundTask)
      )
  }
}
