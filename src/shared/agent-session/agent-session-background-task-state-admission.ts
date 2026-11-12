// Decode child views once at client admission so equality and readers never consume raw wire rows.

import type { AgentSessionBackgroundTaskState } from './agent-session-background-task-wire'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { decodeAgentChildWorkViews } from '../agent-status/child-work/agent-status-child-work-view-wire'
import { AgentSessionForegroundTaskSchema } from './agent-session-foreground-task'

/** Preserve identity on repeated rosters so memoized readers skip unchanged frames. */
export function admitAgentSessionBackgroundTaskState(
  next: AgentSessionBackgroundTaskState | null | undefined,
  previous?: AgentSessionBackgroundTaskState | null
): AgentSessionBackgroundTaskState | null | undefined {
  if (!next) {
    return next
  }
  const { children: raw, foregroundTasks: rawTargets, ...rest } = next
  const children = decodeAgentChildWorkViews(raw)
  const targets = AgentSessionForegroundTaskSchema.array().max(256).safeParse(rawTargets)
  const decoded = {
    ...rest,
    ...(children ? { children } : {}),
    ...(targets.success ? { foregroundTasks: targets.data } : {})
  }
  return previous && backgroundTaskStatesEqual(decoded, previous) ? previous : decoded
}
