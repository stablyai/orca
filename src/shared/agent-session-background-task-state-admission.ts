// Decode child views once at client admission so equality and readers never consume raw wire rows.

import type { AgentSessionBackgroundTaskState } from './agent-session-wire'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { decodeAgentChildWorkViews } from './agent-status-child-work-view-wire'

/** Preserve identity on repeated rosters so memoized readers skip unchanged frames. */
export function admitAgentSessionBackgroundTaskState(
  next: AgentSessionBackgroundTaskState | null | undefined,
  previous?: AgentSessionBackgroundTaskState | null
): AgentSessionBackgroundTaskState | null | undefined {
  if (!next) {
    return next
  }
  const { children: raw, ...rest } = next
  const children = decodeAgentChildWorkViews(raw)
  const decoded = { ...rest, ...(children ? { children } : {}) }
  return previous && backgroundTaskStatesEqual(decoded, previous) ? previous : decoded
}
