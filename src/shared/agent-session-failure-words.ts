// The sentence a person reads beside each failure fact, and the one constructor that writes both.
//
// A row's `text`, a rejected message's `reason` and a conversation command's `error` are what
// every released client prints as they are, so the host writes them here, from the fact, and
// nowhere else: never Orca's own error text, a refusal's message, or a probe's evidence. A
// provider's words reach the sentence only when the provider wrote them for a person. Each sentence
// is built from the pieces in `agent-session-failure-copy`, which desktop translates to word the
// same fact in the reader's language.

import {
  isSubmissionRejectionFact,
  type AgentSessionAttachmentProblem,
  type AgentSessionAttachmentProblemReason,
  type AgentSessionFailureFact,
  type AgentSessionFailureKind,
  type ProviderDiagnostic,
  type SubmissionRejectionFact,
  type SubmissionRejectionKind
} from './agent-session-failure'
import type { AgentSessionConversationCommand } from './agent-session-conversation-command'
import {
  sayAgentSessionFailureEnglish,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues,
  type AgentSessionFailureSay
} from './agent-session-failure-copy'
import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'
import { providerRetryWords, withRetryCause } from './agent-session-provider-retry-words'
import { joinSentences } from './sentence-joining'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'

declare const failureSentence: unique symbol

/** Words only `agentSessionFailureWords` makes, so no writer can put its own beside a fact. */
export type AgentSessionFailureSentence = string & { readonly [failureSentence]: true }

/** A status row that reports a failure. */
export type AgentSessionFailureRowWords = {
  text: AgentSessionFailureSentence
  failure: AgentSessionFailureFact
}

/** A rejection as the host writes it: the sentence (or, for the cases released clients already
 *  hide, the legacy marker) they print, and the fact newer ones read. */
export type AgentJournalDispatchRejection = {
  reason: AgentSessionFailureSentence
  rejection: SubmissionRejectionFact
}

/** `row`: a status row, about the chat. `rejection`: a rejected message's reason, about it. */
export type AgentSessionFailureSurface = 'row' | 'rejection'

export type AgentSessionFailureWordsContext = {
  /** The chat's agent, when the writer knows it. */
  agentName?: string
  /** Names the legacy queue-full marker; without it a full queue is worded as a sentence. */
  provider?: 'claude' | 'codex'
  /** The conversation command a failed start was for, so the next step is to run it again
   *  rather than to send a message. */
  command?: AgentSessionConversationCommand
  /** The surface retries for the person — its own Retry beside the words, or a read that reconnects
   *  on its own — so they leave out sending or trying again. */
  retryControl?: boolean
}

/**
 * Whether a refused start leaves the chat anything to start again from. `false`: this host has
 * nothing to restart it from — no record, or none it can run — so only a new chat continues.
 * A new wire code does not compile until it is classified here.
 */
export const START_REFUSAL_RESUMABLE: Record<AgentSessionWireRefusalCode, boolean> = {
  execution_owner_reconciling: true,
  agent_session_conflict: true,
  agent_session_checkpoint_stale: true,
  agent_session_ownership_unknown: true,
  agent_session_operation_capacity: true,
  structured_agent_session_unsupported: false,
  agent_session_operation_conflict: true,
  agent_session_operation_expired: true,
  agent_session_operation_invalid: true,
  agent_session_operation_unknown: true,
  agent_session_item_revision_stale: true,
  agent_session_already_resolved: true,
  agent_session_identity_required: false,
  agent_session_journal_unreadable: true,
  agent_session_owner_restart_failed: true
}

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512
const BYTES_PER_MB = 1024 * 1024

type Sentence = (
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface,
  say: AgentSessionFailureSay
) => string

function agent(say: AgentSessionFailureSay, { agentName }: AgentSessionFailureWordsContext) {
  return { agent: agentName ?? say('theAgent') }
}

function quotingPersonDetail(
  say: AgentSessionFailureSay,
  lead: AgentSessionFailureCopyId,
  quotedLead: AgentSessionFailureCopyId,
  detail: ProviderDiagnostic | undefined,
  values: AgentSessionFailureCopyValues = {}
): string {
  const quoted =
    detail?.audience === 'person'
      ? detail.text
          .slice(0, MAX_QUOTED_DETAIL_CHARS)
          .trim()
          .replace(/[.\s]+$/, '')
      : ''
  return quoted ? say(quotedLead, { ...values, detail: quoted }) : say(lead, values)
}

/** The next step after a start or restart that failed: the command, or the message, again. */
function startRetry(
  say: AgentSessionFailureSay,
  { command, retryControl }: AgentSessionFailureWordsContext,
  sendAgain: 'sendToTryAgain' | 'sendAgainToTryOnceMore' = 'sendToTryAgain'
): string[] {
  if (retryControl) {
    return []
  }
  return [command ? say('runCommandAgain', { command }) : say(sendAgain)]
}

function couldNot(verb: 'couldNotStart' | 'couldNotRestart'): Sentence {
  return (context, fact, _surface, say) => {
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

// The number only; each language's sentence carries its own unit.
function megabytes(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MB) * 10) / 10)
}

const ATTACHMENT_SENTENCES = {
  empty: (say) => say('attachmentEmpty'),
  tooLarge: (say, _, { limit }) =>
    limit ? say('attachmentLargerThan', { size: megabytes(limit) }) : say('attachmentTooLarge'),
  tooMany: (say, context, { limit }) =>
    limit
      ? say('attachmentAtMost', { ...agent(say, context), limit: String(limit) })
      : say('attachmentTooMany'),
  totalTooLarge: (say, _, { limit }) =>
    limit
      ? say('attachmentTotalMoreThan', { size: megabytes(limit) })
      : say('attachmentTotalTooLarge'),
  unsupportedType: (say, context) => say('attachmentUnsupportedType', agent(say, context)),
  notAFile: (say) => say('attachmentNotAFile'),
  noSource: (say) => say('attachmentNoSource')
} satisfies Record<
  AgentSessionAttachmentProblemReason,
  (
    say: AgentSessionFailureSay,
    context: AgentSessionFailureWordsContext,
    problem: AgentSessionAttachmentProblem
  ) => string
>

const FAILURE_SENTENCES = {
  providerStartFailed: (context, _fact, _surface, say) =>
    joinSentences([say('providerStartFailed', agent(say, context)), ...startRetry(say, context)]),
  startFailed: couldNot('couldNotStart'),
  // Beside a Retry the resend is the button, but signing in is still a step to take first.
  notSignedIn: (context, _fact, _surface, say) =>
    joinSentences([
      say('notSignedIn', agent(say, context)),
      context.retryControl
        ? say('signInFirst')
        : context.command
          ? say('signInThenRunCommand', { command: context.command })
          : say('signInThenSend')
    ]),
  historyTooLarge: (_context, _fact, _surface, say) =>
    joinSentences([say('historyTooLarge'), say('startNewChat')]),
  managedAccountEnvOverride: (_context, _fact, _surface, say) => say('managedAccountEnvOverride'),
  accountSwitchInProgress: (_context, _fact, _surface, say) => say('accountSwitchInProgress'),
  launchFolderMissing: (_context, _fact, _surface, say) => say('launchFolderMissing'),
  managedAccountUnsupported: (context, _fact, _surface, say) =>
    joinSentences([
      say('managedAccountUnsupported'),
      context.retryControl
        ? say('chooseClaudeAccount')
        : context.command
          ? say('chooseClaudeAccountThenRunCommand', { command: context.command })
          : say('chooseClaudeAccountThenSend')
    ]),
  providerExited: (context, _fact, surface, say) =>
    say(surface === 'row' ? 'providerExitedRow' : 'providerExitedRejection', agent(say, context)),
  restartFailed: couldNot('couldNotRestart'),
  providerRejected: (_context, fact, _surface, say) =>
    quotingPersonDetail(say, 'providerRejected', 'providerRejectedQuoted', fact.detail),
  attachmentInvalid: (context, fact, _surface, say) =>
    fact.attachment
      ? ATTACHMENT_SENTENCES[fact.attachment.reason](say, context, fact.attachment)
      : say('attachmentInvalid'),
  attachmentUnreadable: (_context, _fact, _surface, say) => say('attachmentUnreadable'),
  emptyMessage: (_context, _fact, _surface, say) => say('emptyMessage'),
  queueFull: (_context, _fact, _surface, say) => say('queueFull'),
  writeFailed: (_context, _fact, _surface, say) => say('writeFailed'),
  cancelled: (_context, _fact, _surface, say) => say('cancelled'),
  chatClosed: (_context, _fact, _surface, say) => say('chatClosed'),
  hostRestarted: (_context, _fact, _surface, say) => say('hostRestarted'),
  notDelivered: ({ retryControl }, _fact, _surface, say) =>
    say(retryControl ? 'notDelivered' : 'notDeliveredSendAgain'),
  commandRefused: ({ retryControl }, _fact, _surface, say) =>
    say(retryControl ? 'commandRefused' : 'commandRefusedTryAgain'),
  compactionFailed: (_context, fact, _surface, say) =>
    quotingPersonDetail(say, 'compactionFailed', 'compactionFailedQuoted', fact.detail),
  compactionUnconfirmed: (_context, _fact, _surface, say) => say('compactionUnconfirmed'),
  cancelUnconfirmed: (_context, _fact, _surface, say) => say('cancelUnconfirmed'),
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
  previousExitUnverifiable: (context, _fact, _surface, say) =>
    say('previousExitUnverifiable', agent(say, context))
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

/** The markers released clients hide, for the rejections that had one before rows carried a fact.
 *  A write failure is the bare marker: its error belongs in the log. */
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
