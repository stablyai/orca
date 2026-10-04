import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { agentSubagentsEqual } from '../../../../shared/agent-status-types'
import { agentChildWorkViewsEqual } from '../../../../shared/agent-status-child-work-view-wire'
import type { AgentStatusPayload } from './agent-status-contract'

/** A row's child fields, reusing the previous arrays when unchanged so the rows derived from them
 *  keep their identity. `children` is the host's views; `subagents` the legacy roster. */
export function liveEntryChildFields(
  existing: AgentStatusEntry | undefined,
  payload: AgentStatusPayload
): Pick<AgentStatusEntry, 'subagents' | 'children'> {
  return {
    subagents: agentSubagentsEqual(existing?.subagents, payload.subagents)
      ? existing?.subagents
      : payload.subagents,
    ...(payload.children
      ? {
          children: agentChildWorkViewsEqual(existing?.children, payload.children)
            ? existing?.children
            : payload.children
        }
      : {})
  }
}
