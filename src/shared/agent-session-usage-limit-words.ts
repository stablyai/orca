// The words for a usage limit an agent hit: which limit, when it resets, and how to continue.

import {
  sayAgentSessionFailureEnglish,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues,
  type AgentSessionFailureSay
} from './agent-session-failure-copy'
import {
  formatUsageLimitResetClock,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from './agent-session-usage-limit'
import { joinSentences } from './sentence-joining'

/** A reset time in the reader's own clock. The host writes none: its time zone need not be the
 *  reader's, and a saved wait goes stale. */
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
    /** The surface offers its own Continue, so the words leave out sending a message. */
    continueControl?: boolean
  }
): string {
  const lead = limit?.window
    ? say('usageLimitReachedNamed', { ...agent, window: say(WINDOW_COPY[limit.window]) })
    : say('usageLimitReached', agent)
  const reset = limit?.resetsAt !== undefined ? context.resetWords?.(limit.resetsAt) : null
  return joinSentences([
    lead,
    ...(reset ? [say('usageLimitResetsAt', { when: reset })] : []),
    ...(context.continueControl ? [] : [say('usageLimitSendAfterReset')])
  ])
}

/** A usage-limit line for a reader that has no agent name to reword it with (the phone): the host's
 *  sentence, then the reset in this reader's clock. Any other line keeps its text. */
export function usageLimitLineText(block: {
  text: string
  failure?: { kind: string; usageLimit?: AgentSessionUsageLimit }
}): string {
  const resetsAt =
    block.failure?.kind === 'usageLimitReached' ? block.failure.usageLimit?.resetsAt : undefined
  return resetsAt === undefined
    ? block.text
    : joinSentences([
        block.text,
        sayAgentSessionFailureEnglish('usageLimitResetsAt', {
          when: formatUsageLimitResetClock(resetsAt)
        })
      ])
}
