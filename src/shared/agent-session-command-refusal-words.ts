import type { AgentSessionFailureFact } from './agent-session-failure'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureSay
} from './agent-session-failure-copy'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import { agentSessionRefusalReasonWords } from './agent-session-refusal-reason-words'
import type { AgentSessionWriteNoticeSentence } from './agent-session-write-notice-copy'
import { joinSentences } from './sentence-joining'

const NAMED_CAUSES: Partial<Record<AgentSessionWriteNoticeSentence, AgentSessionFailureCopyId>> = {
  agentStarting: 'commandAgentStarting',
  waitForStart: 'commandWaitForStart',
  turnActive: 'commandTurnActive',
  waitForTurn: 'commandWaitForTurn',
  promptPending: 'commandPromptPending',
  agentRefused: 'commandAgentRefused',
  ownerUnproven: 'commandOwnerUnproven',
  goalsUnsupported: 'commandGoalsUnsupported',
  optionRejected: 'commandOptionRejected',
  backgroundTasksRunning: 'commandBackgroundTasksRunning'
}

/** A refused command keeps the refusal's action; repeating it cannot clear every refusal. */
export function agentSessionCommandRefusalWords(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext,
  say: AgentSessionFailureSay,
  sayNotice: (id: AgentSessionWriteNoticeSentence) => string
): string {
  const agent = { agent: context.agentName ?? say('theAgent') }
  const notice = (id: AgentSessionWriteNoticeSentence): string => {
    const named = NAMED_CAUSES[id]
    return named ? say(named, agent) : sayNotice(id)
  }
  if (fact.refusal?.code === 'structured_agent_session_unsupported') {
    return say('commandUnsupported', agent)
  }
  const lead = say('commandRefused', agent)
  const reason = fact.refusal?.details?.reason
  if (context.command) {
    const values = { ...agent, command: context.command }
    if (reason === 'turnActive' || reason === 'messagesUnsettled') {
      return joinSentences([say('commandStillWorking', agent), say('runCommandWhenDone', values)])
    }
    if (reason === 'promptPending') {
      if (!context.agentName) {
        return sayNotice(context.command === 'clear' ? 'clearAfterAnswer' : 'compactAfterAnswer')
      }
      return say('commandAfterAnswer', values)
    }
    if (reason === 'backgroundTasksRunning' || reason === 'handoffInFlight') {
      return joinSentences([
        notice(reason === 'handoffInFlight' ? 'agentStarting' : 'backgroundTasksRunning'),
        notice(reason === 'handoffInFlight' ? 'waitForStart' : 'waitForBackgroundTasks'),
        say('runCommandAgain', values)
      ])
    }
  }
  const words = fact.refusal
    ? agentSessionRefusalReasonWords({ kind: 'refused', ...fact.refusal })
    : undefined
  if (!words || 'fact' in words) {
    return lead
  }
  const retry = words.action === 'retry' && !context.retryControl
  return joinSentences([
    lead,
    ...('cause' in words ? [notice(words.cause)] : []),
    ...('step' in words && words.step && (words.action !== 'retry' || retry)
      ? [notice(words.step)]
      : retry
        ? [sayNotice('tryAgain')]
        : [])
  ])
}
