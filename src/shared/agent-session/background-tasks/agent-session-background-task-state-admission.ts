// Decode child views once at client admission so equality and readers never consume raw wire rows.

import type { AgentSessionBackgroundTaskState } from './agent-session-background-task-wire'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { decodeAgentChildWorkViews } from '../../agent-status/child-work/agent-status-child-work-view-wire'
import { decodeCommandDetailsAvailable } from './agent-session-command-details'

/** Preserve identity on repeated rosters so memoized readers skip unchanged frames. */
export function admitAgentSessionBackgroundTaskState(
  next: AgentSessionBackgroundTaskState | null | undefined,
  previous?: AgentSessionBackgroundTaskState | null
): AgentSessionBackgroundTaskState | null | undefined {
  if (!next) {
    return next
  }
  const { children: raw, commandDetailsAvailable: rawAvailable, ...rest } = next
  const children = decodeAgentChildWorkViews(raw)
  // Decoded against this same roster's children, never passed through.
  const commandDetailsAvailable = decodeCommandDetailsAvailable(rawAvailable, children)
  const decoded = {
    ...rest,
    ...(children ? { children } : {}),
    ...(commandDetailsAvailable ? { commandDetailsAvailable } : {})
  }
  return previous && backgroundTaskStatesEqual(decoded, previous) ? previous : decoded
}
