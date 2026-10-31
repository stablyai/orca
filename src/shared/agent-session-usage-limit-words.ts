// The words for a usage limit an agent hit: which limit and when it resets.

import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from './agent-session-failure-copy'
import type {
  AgentSessionUsageLimit,
  AgentSessionUsageLimitWindow
} from './agent-session-usage-limit'
import { joinSentences } from './sentence-joining'

/** Render reset in the reader's clock; the host timezone may differ and persisted waits become stale. */
export type AgentSessionUsageLimitResetWords = (resetsAt: number) => string | null

const WINDOW_COPY = {
  session: 'usageLimitWindowSession',
  weekly: 'usageLimitWindowWeekly',
  weeklyModel: 'usageLimitWindowWeeklyModel',
  credits: 'usageLimitWindowCredits'
} as const satisfies Record<AgentSessionUsageLimitWindow, AgentSessionFailureCopyId>

export function usageLimitWords(
  say: AgentSessionFailureSay,
  agent: AgentSessionFailureCopyValues,
  limit: AgentSessionUsageLimit | undefined,
  context: {
    resetWords?: AgentSessionUsageLimitResetWords
  }
): string {
  const lead = limit?.window
    ? say('usageLimitReachedNamed', { ...agent, window: say(WINDOW_COPY[limit.window]) })
    : say('usageLimitReached', agent)
  const reset = limit?.resetsAt !== undefined ? context.resetWords?.(limit.resetsAt) : null
  return joinSentences([lead, ...(reset ? [say('usageLimitResetsAt', { when: reset })] : [])])
}
