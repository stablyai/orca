// Shared row wording keeps name/state fallbacks and lead/detail order consistent across surfaces.

import type { AgentChildRowModel } from './agent-child-row-model'
import type { AgentChildDisplayState } from './agent-status-child-work-display'
import { formatAgentTypeLabel } from './agent-type-label'
import { formatAgentToolPreviewLine } from './agent-tool-preview'
import { agentNoUpdateLabel } from './agent-row-decay-state'
import type { BackgroundTaskSay } from './background-task-copy'
import { backgroundTaskStateReason, backgroundTaskStateWord } from './background-task-roster'

/** The words each surface supplies: desktop translates them, mobile reads English. */
export type AgentChildRowCopy = {
  stateLabel: (state: AgentChildDisplayState) => string
  ended: () => string
  sayBackgroundTask: BackgroundTaskSay
}

/** The row's name, or its state's words when the child reported none. */
export function agentChildRowName(
  row: Pick<AgentChildRowModel, 'name' | 'displayState'>,
  stateLabel: (state: AgentChildDisplayState) => string
): string {
  return row.name.trim() || stateLabel(row.displayState)
}

export function agentChildRowLeadTrail(
  row: Pick<AgentChildRowModel, 'displayState'>,
  name: string,
  detail: string
): { lead: string; trail: string } {
  // Lead with monitoring state so truncation still distinguishes passive work.
  if (row.displayState === 'monitoring' && detail) {
    return { lead: detail, trail: detail === name ? '' : name }
  }
  return { lead: name, trail: detail }
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
