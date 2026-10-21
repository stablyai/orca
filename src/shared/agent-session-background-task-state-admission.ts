// The background-task roster as a client keeps it: `children` decoded once, where the frame enters
// the client's state, so equality and every reader see decoded rows and nothing reads raw wire rows.

import type { AgentSessionBackgroundTaskState } from './agent-session-wire'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { decodeAgentChildWorkViews } from './agent-status-child-work-view-wire'

/** `previous` is kept, identity included, when the frame repeats it, so readers memoized on the
 *  roster skip an unchanged frame. */
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
