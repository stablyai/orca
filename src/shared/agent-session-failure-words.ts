// Build legacy text/reason/error and newer typed facts together. Quote provider text only when authored for a person; shared sentence pieces let desktop translate the same fact.

import {
  isSubmissionRejectionFact,
  type AgentSessionFailureFact,
  type AgentSessionFailureKind,
  type SubmissionRejectionFact,
  type SubmissionRejectionKind
} from './agent-session-failure'
import type { AgentSessionConversationCommand } from './agent-session/agent-session-conversation-command'
import { cliMissingSentence, notSignedInSentence } from './agent-session-availability-sentences'
import {
  agentCliInstallationFailureWords,
  sayAgentSessionFailureEnglish,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureSay
} from './agent-session-failure-copy'
import { AGENT_SESSION_GOAL_CONTROL_COPY } from './agent-session-goal-control-copy'
import { START_REFUSAL_RESUMABLE } from './agent-session-start-refusal-resumable'
import { providerRetryWords, withRetryCause } from './agent-session-provider-retry-words'
import {
  usageLimitWords,
  type AgentSessionUsageLimitResetWords
} from './agent-session-usage-limit-words'
import { commandRefusedByReason } from './agent-session-command-refusal-words'
import { agent, attachmentProblemSentence } from './agent-session-attachment-failure-words'
import { joinSentences } from './sentence-joining'
import { quotingPersonDetail } from './agent-session-failure-quoted-detail'
import { requestTimeoutSeconds } from './agent-session-request-timeout'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'

declare const failureSentence: unique symbol

/** Only agentSessionFailureWords constructs these, preventing competing wording beside a fact. */
export type AgentSessionFailureSentence = string & { readonly [failureSentence]: true }

export type AgentSessionFailureRowWords = {
  text: AgentSessionFailureSentence
  failure: AgentSessionFailureFact
}

/** Legacy sentence/hidden marker and the newer fact, written together by the host. */
export type AgentJournalDispatchRejection = {
  reason: AgentSessionFailureSentence
  rejection: SubmissionRejectionFact
}

/** row describes the chat; rejection describes a rejected message; answer describes a refused approval/question answer. */
export type AgentSessionFailureSurface = 'row' | 'rejection' | 'answer'

export type AgentSessionFailureWordsContext = {
  /** The chat's agent, when the writer knows it. */
  agentName?: string
  stopNotice?: 'pauseUnconfirmed' | 'stopUnconfirmed'
  /** Names the legacy queue-full marker; without it a full queue is worded as a sentence. */
  provider?: 'claude' | 'codex'
  /** Retry the failed start's conversation command instead of sending a message. */
  command?: AgentSessionConversationCommand
  /** Omit retry advice when the surface already retries or offers its own Retry control. */
  retryControl?: boolean
  /** A direct create has no submitted message to send again. */
  messageSubmitted?: boolean
  /** The chat runs on this WSL distro's host; desktop-only, since the host can't name itself so. */
  wslDistro?: string
  /** How this reader says a usage limit's reset; without it the words name no time. */
  usageLimitReset?: AgentSessionUsageLimitResetWords
}

type Sentence = (
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface,
  say: AgentSessionFailureSay
) => string

function namingAgent(id: AgentSessionFailureCopyId): Sentence {
  return (context, _fact, _surface, say) => say(id, agent(say, context))
}

/** The next step after a start or restart that failed: the command, or the message, again. */
function startRetry(
  say: AgentSessionFailureSay,
  { command, retryControl, messageSubmitted }: AgentSessionFailureWordsContext,
  sendAgain: 'sendToTryAgain' | 'sendAgainToTryOnceMore' = 'sendToTryAgain'
): string[] {
  if (retryControl) {
    return []
  }
  return [
    command
      ? say('runCommandAgain', { command })
      : say(messageSubmitted === false ? 'sendToTryAgain' : sendAgain)
  ]
}

function couldNot(verb: 'couldNotStart' | 'couldNotRestart'): Sentence {
  return (context, fact, _surface, say) => {
    const installationFailure = agentCliInstallationFailureWords(fact.refusal, say)
    if (installationFailure) {
      return installationFailure
    }
    const failed = say(verb, agent(say, context))
    if (fact.argumentProblem) {
      const problemCopy = {
        unsupportedOption: 'argumentsUnsupportedOption',
        missingValue: 'argumentsMissingValue',
        multipleValues: 'argumentsMultipleValues',
        positionalPrompt: 'argumentsPositionalPrompt'
      } as const
      return joinSentences([
        failed,
        say(problemCopy[fact.argumentProblem.problem], { option: fact.argumentProblem.option }),
        say('editSavedArguments'),
        ...startRetry(say, context)
      ])
    }
    if (fact.requestTimeout) {
      return joinSentences([
        say('startTimedOut', {
          ...agent(say, context),
          method: fact.requestTimeout.method,
          seconds: requestTimeoutSeconds(fact.requestTimeout)
        }),
        ...startRetry(say, context),
        // No cause named: MCP startup, the network or config can stall a start too.
        say('startTimedOutKeepsHappening')
      ])
    }
    // Only a terminal agent an older build recorded holds a claim; quitting it frees the chat.
    if (fact.refusal?.details?.reason === 'claimConflicted') {
      return joinSentences([failed, say('terminalAgentHoldsChat'), say('quitTerminalAgent')])
    }
    // The previous process may still run, so nothing started: that, never that it exited.
    if (fact.refusal?.details?.reason === 'previousExitUnverifiable') {
      return joinSentences([
        say('previousExitUnverifiable', agent(say, context)),
        ...startRetry(say, context, 'sendAgainToTryOnceMore')
      ])
    }
    const code = fact.refusal?.code
    return joinSentences(
      code && !START_REFUSAL_RESUMABLE[code]
        ? [failed, say('startNewChat')]
        : [failed, ...startRetry(say, context)]
    )
  }
}

const FAILURE_SENTENCES = {
  providerStartFailed: (context, _fact, _surface, say) =>
    joinSentences([say('providerStartFailed', agent(say, context)), ...startRetry(say, context)]),
  startFailed: couldNot('couldNotStart'),
  notSignedIn: (context, fact, surface, say) => notSignedInSentence(context, fact, say, surface),
  cliMissing: (context, _fact, _surface, say) => cliMissingSentence(context, say),
  historyTooLarge: (_context, _fact, _surface, say) =>
    joinSentences([say('historyTooLarge'), say('startNewChat')]),
  managedAccountEnvOverride: (_context, _fact, _surface, say) => say('managedAccountEnvOverride'),
  accountSwitchInProgress: namingAgent('accountSwitchInProgress'),
  launchFolderMissing: (_context, _fact, _surface, say) => say('launchFolderMissing'),
  historyInOtherAccount: (_context, _fact, _surface, say) => say('historyInOtherAccount'),
  claudeAccountFolderMissing: (_context, _fact, _surface, say) => say('claudeAccountFolderMissing'),
  claudeAccountSetupFailed: (_context, _fact, _surface, say) => say('claudeAccountSetupFailed'),
  agentCommandNotRunnable: namingAgent('agentCommandNotRunnable'),
  runtimeNotInstalled: namingAgent('runtimeNotInstalled'),
  fullAccessAsRoot: namingAgent('fullAccessAsRoot'),
  launchPreparationFailed: (context, _fact, _surface, say) =>
    joinSentences([
      say('launchPreparationFailed', agent(say, context)),
      ...startRetry(say, context)
    ]),
  conversationOpenInTerminal: namingAgent('conversationOpenInTerminal'),
  conversationOpenElsewhere: (_context, _fact, _surface, say) => say('conversationOpenElsewhere'),
  managedAccountUnsupported: (context, _fact, _surface, say) =>
    joinSentences([
      say('managedAccountUnsupported'),
      context.retryControl || context.messageSubmitted === false
        ? say('chooseClaudeAccount')
        : context.command
          ? say('chooseClaudeAccountThenRunCommand', { command: context.command })
          : say('chooseClaudeAccountThenSend')
    ]),
  providerExited: (context, _fact, surface, say) =>
    say(
      surface === 'row'
        ? 'providerExitedRow'
        : surface === 'answer'
          ? 'providerExitedAnswer'
          : 'providerExitedRejection',
      agent(say, context)
    ),
  restartFailed: couldNot('couldNotRestart'),
  claudeEffortInvalid: (_context, _fact, _surface, say) => say('claudeEffortInvalid'),
  modelUnavailable: (context, fact, _surface, say) =>
    say('modelUnavailable', { ...agent(say, context), detail: fact.detail?.text ?? 'this model' }),
  providerRejected: (context, fact, _surface, say) =>
    quotingPersonDetail(
      say,
      'providerRejected',
      'providerRejectedQuoted',
      fact.detail,
      agent(say, context)
    ),
  attachmentInvalid: (context, fact, _surface, say) =>
    fact.attachment
      ? attachmentProblemSentence(say, context, fact.attachment)
      : say('attachmentInvalid'),
  attachmentUnreadable: (_context, _fact, _surface, say) => say('attachmentUnreadable'),
  emptyMessage: (_context, _fact, _surface, say) => say('emptyMessage'),
  commandUnavailable: namingAgent('commandUnavailable'),
  queueFull: (_context, _fact, _surface, say) => say('queueFull'),
  writeFailed: (_context, _fact, _surface, say) => say('writeFailed'),
  cancelled: (_context, _fact, _surface, say) => say('cancelled'),
  chatClosed: (_context, _fact, _surface, say) => say('chatClosed'),
  hostRestarted: (_context, _fact, _surface, say) => say('hostRestarted'),
  notDelivered: ({ retryControl }, _fact, _surface, say) =>
    say(retryControl ? 'notDelivered' : 'notDeliveredSendAgain'),
  commandRefused: (context, fact, _surface, say) =>
    commandRefusedByReason(say, context, fact) ??
    say(context.retryControl ? 'commandRefused' : 'commandRefusedTryAgain'),
  compactionFailed: (_context, fact, _surface, say) =>
    quotingPersonDetail(say, 'compactionFailed', 'compactionFailedQuoted', fact.detail),
  compactionUnconfirmed: (_context, _fact, _surface, say) => say('compactionUnconfirmed'),
  cancelUnconfirmed: ({ stopNotice }, _fact, _surface, say) =>
    stopNotice ? AGENT_SESSION_GOAL_CONTROL_COPY[stopNotice] : say('cancelUnconfirmed'),
  // The agent was reached and declined, so the sentence says that, not that the Stop was lost.
  stopRefused: (context, fact, _surface, say) =>
    fact.detail?.audience === 'person'
      ? quotingPersonDetail(
          say,
          'stopRefused',
          'stopRefusedQuoted',
          fact.detail,
          agent(say, context)
        )
      : say('noTurnToStop', agent(say, context)),
  // Mid-sentence, so an unnamed agent is not capitalized.
  stopFailed: ({ agentName }, _fact, _surface, say) =>
    agentName ? say('couldNotStop', { agent: agentName }) : say('couldNotStopTheAgent'),
  backgroundTaskNotStopped: (_context, fact, _surface, say) =>
    say(fact.backgroundStop === 'task' ? 'backgroundTaskNotStopped' : 'backgroundTasksNotStopped'),
  answerUnconfirmed: (_context, _fact, _surface, say) => say('answerUnconfirmed'),
  hostFault: ({ retryControl }, _fact, _surface, say) =>
    say(retryControl ? 'hostFault' : 'hostFaultTryAgain'),
  hostStopped: (context, _fact, _surface, say) => say('hostStopped', agent(say, context)),
  // A provider that says how its retry is going, for a person, is quoted: that is the progress.
  providerRetrying: (context, { retry, detail }, _surface, say) =>
    detail?.audience === 'person'
      ? withRetryCause(
          quotingPersonDetail(
            say,
            'providerRetrying',
            'providerRetryingQuoted',
            detail,
            agent(say, context)
          ),
          retry?.cause
        )
      : providerRetryWords(say, agent(say, context), retry),
  usageLimitReached: (context, { usageLimit }, _surface, say) =>
    usageLimitWords(say, agent(say, context), usageLimit, {
      resetWords: context.usageLimitReset
    }),
  previousExitUnverifiable: namingAgent('previousExitUnverifiable'),
  sessionNotRestored: namingAgent('sessionNotRestored')
} satisfies Record<AgentSessionFailureKind, Sentence>

/** The sentence a person reads for this fact on this surface; never a marker. */
export function agentSessionFailureSentence(
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface,
  context: AgentSessionFailureWordsContext = {},
  /** Desktop passes its translations; the host and the phone keep English. */
  say: AgentSessionFailureSay = sayAgentSessionFailureEnglish
): string {
  const sentence: Sentence = FAILURE_SENTENCES[fact.kind]
  return sentence(context, fact, surface, say)
}

/** Preserve markers released clients hide. A write failure keeps the bare marker; its error stays in the log. */
const LEGACY_REJECTION_MARKERS: Partial<
  Record<SubmissionRejectionKind, (context: AgentSessionFailureWordsContext) => string | undefined>
> = {
  cancelled: () => DISPATCH_REJECTED_CANCELLED,
  writeFailed: () => DISPATCH_REJECTED_WRITE_FAILED,
  queueFull: ({ provider }) =>
    provider === 'codex'
      ? DISPATCH_REJECTED_CODEX_QUEUE_FULL
      : provider === 'claude'
        ? DISPATCH_REJECTED_QUEUE_FULL
        : undefined
}

/** The words a status row reporting this fact records. */
export function agentSessionFailureWords(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext & { surface: 'row' }
): AgentSessionFailureRowWords
/** The words a message rejected for this fact records. */
export function agentSessionFailureWords(
  fact: SubmissionRejectionFact,
  context: AgentSessionFailureWordsContext & { surface: 'rejection' }
): AgentJournalDispatchRejection
export function agentSessionFailureWords(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext & { surface: AgentSessionFailureSurface }
): AgentSessionFailureRowWords | AgentJournalDispatchRejection {
  if (context.surface === 'row') {
    return { text: branded(agentSessionFailureSentence(fact, 'row', context)), failure: fact }
  }
  // The rejection overload admits only these; a caller that got past the types is Orca's bug.
  if (!isSubmissionRejectionFact(fact)) {
    throw new Error(`agent session failure kind ${fact.kind} cannot reject a message`)
  }
  const words =
    LEGACY_REJECTION_MARKERS[fact.kind]?.(context) ??
    agentSessionFailureSentence(fact, 'rejection', context)
  return { reason: branded(words), rejection: fact }
}

function branded(words: string): AgentSessionFailureSentence {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `agentSessionFailureWords` calls this, with words from the table or a legacy marker for its fact.
  return words as AgentSessionFailureSentence
}
