// The sentence a person reads beside each failure fact, and the one constructor that writes both.
//
// A row's `text`, a rejected message's `reason` and a conversation command's `error` are what
// every released client prints as they are, so the host writes them here, from the fact, and
// nowhere else: never Orca's own error text, a refusal's message, or a probe's evidence. A
// provider's words reach the sentence only when the provider wrote them for a person. The table
// is also the English default for a client that chooses its own copy from the fact.

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
import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'
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
  command?: 'clear'
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

/** Sentences a refusal notice shows too, so a chat says them one way. */
export const TERMINAL_AGENT_HOLDS_CHAT = 'This chat is still open in a terminal agent.'
export const QUIT_TERMINAL_AGENT = 'Quit that agent to continue the chat here.'
export const START_NEW_CHAT = 'Start a new chat to continue.'

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512
const BYTES_PER_MB = 1024 * 1024

type Sentence = (
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface
) => string

function quotingPersonDetail(lead: string, detail: ProviderDiagnostic | undefined): string {
  const quoted =
    detail?.audience === 'person'
      ? detail.text
          .slice(0, MAX_QUOTED_DETAIL_CHARS)
          .trim()
          .replace(/[.\s]+$/, '')
      : ''
  return quoted ? `${lead}: ${quoted}.` : `${lead}.`
}

/** What to do once the start can work, for a sentence that ends in it. */
function retryStep({ command }: AgentSessionFailureWordsContext): string {
  return command === 'clear' ? 'run /clear again' : 'send your message again'
}

/** The next step after a start or restart that failed: the command, or the message, again. */
function startRetry({ command, retryControl }: AgentSessionFailureWordsContext): string {
  if (retryControl) {
    return ''
  }
  return command === 'clear' ? ' Run /clear again.' : ' Send your message to try again.'
}

function couldNot(verb: string): Sentence {
  return (context, fact) => {
    const { agentName } = context
    const failed = `${agentName ?? 'The agent'} couldn't ${verb}.`
    // Only a terminal agent an older build recorded holds a claim; quitting it frees the chat.
    if (fact.refusal?.details?.reason === 'claimConflicted') {
      return `${failed} ${TERMINAL_AGENT_HOLDS_CHAT} ${QUIT_TERMINAL_AGENT}`
    }
    const code = fact.refusal?.code
    return code && !START_REFUSAL_RESUMABLE[code]
      ? `${failed} ${START_NEW_CHAT}`
      : `${failed}${startRetry(context)}`
  }
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / BYTES_PER_MB) * 10) / 10} MB`
}

const NOT_SENT = 'so the message was not sent.'

const ATTACHMENT_SENTENCES = {
  empty: () => `An image on this message is empty, ${NOT_SENT}`,
  tooLarge: (_, { limit }) =>
    limit
      ? `An image on this message is larger than ${megabytes(limit)}, ${NOT_SENT}`
      : `An image on this message is too large, ${NOT_SENT}`,
  tooMany: ({ agentName }, { limit }) =>
    limit
      ? `${agentName ?? 'The agent'} accepts at most ${limit} images in one message, so this message was not sent.`
      : 'This message has too many images, so it was not sent.',
  totalTooLarge: (_, { limit }) =>
    limit
      ? `The images on this message add up to more than ${megabytes(limit)}, ${NOT_SENT}`
      : `The images on this message are too large together, ${NOT_SENT}`,
  unsupportedType: ({ agentName }) =>
    `${agentName ?? 'The agent'} accepts only PNG, JPEG, GIF, and WebP images, so this message was not sent.`,
  notAFile: () => `An image on this message isn't a file, ${NOT_SENT}`,
  noSource: () => `An image on this message has no file to send, ${NOT_SENT}`
} satisfies Record<
  AgentSessionAttachmentProblemReason,
  (context: AgentSessionFailureWordsContext, problem: AgentSessionAttachmentProblem) => string
>

const FAILURE_SENTENCES = {
  providerStartFailed: (context) =>
    `${context.agentName ?? 'The agent'} stopped before it finished starting.${startRetry(context)}`,
  startFailed: couldNot('start'),
  // Beside a Retry the resend is the button, but signing in is still a step to take first.
  notSignedIn: (context) =>
    `${context.agentName ?? 'The agent'} is not signed in for the selected account. ${context.retryControl ? 'Sign in first.' : `Sign in, then ${retryStep(context)}.`}`,
  historyTooLarge: () =>
    `This conversation's history is too large to restore here. ${START_NEW_CHAT}`,
  managedAccountEnvOverride: () =>
    'This Claude launch sets its own Anthropic sign-in variables. Remove them to use a managed Claude account.',
  accountSwitchInProgress: () =>
    'A Claude account switch is in progress. Try again after it finishes.',
  managedAccountUnsupported: (context) =>
    `While a Claude account is added in WSL, Claude chats need a Windows Claude account. Choose or add one in Claude Accounts settings${context.retryControl ? '' : `, then ${retryStep(context)}`}.`,
  providerExited: ({ agentName }, _, surface) =>
    surface === 'row'
      ? `${agentName ?? 'The agent'} stopped while this response was in progress. You can continue in this conversation.`
      : `${agentName ?? 'The agent'} stopped before this message was sent.`,
  restartFailed: couldNot('restart'),
  providerRejected: (_, fact) =>
    quotingPersonDetail('The provider did not accept this message', fact.detail),
  attachmentInvalid: (context, fact) =>
    fact.attachment
      ? ATTACHMENT_SENTENCES[fact.attachment.reason](context, fact.attachment)
      : "An attachment on this message can't be sent to the agent.",
  attachmentUnreadable: () => `An attachment on this message couldn't be read, ${NOT_SENT}`,
  emptyMessage: () => 'This message is empty, so it was not sent.',
  queueFull: () => 'Too many messages were waiting for the agent, so this one was not sent.',
  writeFailed: () => "Orca couldn't hand this message to the agent, so it was not sent.",
  cancelled: () => 'This message was withdrawn before the agent started it.',
  chatClosed: () => 'The chat closed before this message was sent.',
  hostRestarted: () => 'Orca restarted before this message was sent.',
  notDelivered: ({ retryControl }) =>
    retryControl
      ? 'This message was not delivered.'
      : 'This message was not delivered. Send it again to continue.',
  compactionFailed: (_, fact) => quotingPersonDetail('Compaction failed', fact.detail),
  compactionUnconfirmed: () => 'Compaction completion is unconfirmed.',
  cancelUnconfirmed: () => 'Cancellation was not confirmed.',
  answerUnconfirmed: () => 'Your answer was recorded but the agent did not confirm it.',
  hostFault: ({ retryControl }) =>
    `Orca ran into a problem, so this didn't go through.${retryControl ? '' : ' Try again.'}`,
  hostStopped: ({ agentName }) =>
    `${agentName ?? 'The agent'} never finished starting, so Orca stopped it.`,
  providerRetrying: ({ agentName }, { retry }) =>
    retry?.error === 'rate_limit' || retry?.status === 429
      ? `${agentName ?? 'The agent'} is rate-limited and retrying.`
      : `${agentName ?? 'The agent'} hit a temporary problem and is retrying.`
} satisfies Record<AgentSessionFailureKind, Sentence>

/** The sentence a person reads for this fact on this surface; never a marker. */
export function agentSessionFailureSentence(
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface,
  context: AgentSessionFailureWordsContext = {}
): string {
  const sentence: Sentence = FAILURE_SENTENCES[fact.kind]
  return sentence(context, fact, surface)
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
