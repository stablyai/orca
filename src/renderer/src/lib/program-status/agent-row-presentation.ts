import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  resolveProgramStatusPresentation,
  type ProgramStatusPresentation
} from '../../../../shared/program-status/presentation'

type RowProgramStatus = {
  presentation: ProgramStatusPresentation
  /** 'permission' while the program reports a block the row's own state doesn't show. */
  dotStateOverride: 'permission' | null
}

/** What an agent row's OSC 7501 facet adds, resolved once per render for every part of the row. */
export function resolveRowProgramStatus(agent: {
  entry: Pick<AgentStatusEntry, 'state' | 'programStatus' | 'toolName'>
  childRow?: unknown
}): RowProgramStatus {
  // Why no child facet: a child row's entry is synthesized from its parent pane, which owns the status.
  const presentation = resolveProgramStatusPresentation(agent.childRow ? null : agent.entry)
  return { presentation, dotStateOverride: presentation.attention ? 'permission' : null }
}
