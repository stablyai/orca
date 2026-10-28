// Reuse actionable refusal wording so the row names what to wait for instead of suggesting a retry.

import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
import type { AgentSessionConversationCommand } from './agent-session/agent-session-conversation-command'
import { joinSentences } from './sentence-joining'

type ReasonWords = (
  say: AgentSessionFailureSay,
  command: AgentSessionConversationCommand | undefined
) => string | undefined

const STILL_WORKING: ReasonWords = (say, command) =>
  command
    ? joinSentences([say('agentStillWorking'), say('runCommandWhenDone', { command })])
    : undefined

/** A wait the person ends: nothing runs the command after it, so they run it again. */
const WAIT_THEN_RUN_AGAIN =
  (
    cause: 'backgroundTasksRunning' | 'agentStarting',
    wait: 'waitForBackgroundTasks' | 'waitForStart'
  ): ReasonWords =>
  (say, command) =>
    joinSentences([
      say(cause),
      say(wait),
      ...(command ? [say('runCommandAgain', { command })] : [])
    ])

const WORDS_BY_REASON: Partial<Record<string, ReasonWords>> = {
  backgroundTasksRunning: WAIT_THEN_RUN_AGAIN('backgroundTasksRunning', 'waitForBackgroundTasks'),
  handoffInFlight: WAIT_THEN_RUN_AGAIN('agentStarting', 'waitForStart'),
  turnActive: STILL_WORKING,
  messagesUnsettled: STILL_WORKING,
  promptPending: (say, command) => (command ? say('commandAfterAnswer', { command }) : undefined)
}

/** Undefined for a reason with no words of its own: the command's generic sentence says it. */
export function commandRefusedByReason(
  say: AgentSessionFailureSay,
  { command }: { command?: AgentSessionConversationCommand },
  fact: AgentSessionFailureFact
): string | undefined {
  const details = fact.refusal?.details
  const reason = details && 'reason' in details ? details.reason : undefined
  return reason === undefined ? undefined : WORDS_BY_REASON[reason]?.(say, command)
}
