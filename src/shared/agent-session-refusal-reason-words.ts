// The words and next step each refusal reason gets, for every code: a reason the host adds does not
// compile until it has words here.

import type { AgentSessionFailureKind } from './agent-session-failure'
import type { AgentSessionRefusalReason } from './agent-session-refusal-details'
import type { AgentSessionWriteNoticeSentence } from './agent-session-write-notice-copy'
import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'
import type { AgentSessionWriteRefusal } from './agent-session-write-failure'

/** What the person can do about a refusal with this reason. */
export type AgentSessionRefusalAction =
  /** Use the control that sent the write again. */
  | 'retry'
  /** Wait for what the notice names; its step says what. */
  | 'wait'
  /** Take the step the notice names first. */
  | 'actFirst'
  /** Continue somewhere else: the current conversation, or a new chat. */
  | 'goElsewhere'
  | 'checkChat'
  | 'updateOrca'
  /** What the write was for is over: the question it answered moved on. */
  | 'nothingLeft'
  /** Orca's own state or fault; nothing the person does gets past it. */
  | 'hostFinding'

export type AgentSessionRefusalReasonWords =
  /** The code's own words are the honest ones for this reason. */
  | { words: 'code'; action: AgentSessionRefusalAction }
  /** What stopped the write, and the step past it where the person has one to take. */
  | {
      cause: AgentSessionWriteNoticeSentence
      step?: AgentSessionWriteNoticeSentence
      action: AgentSessionRefusalAction
      /** Its words when what failed is reading the chat's history. */
      history?: { cause: AgentSessionWriteNoticeSentence; step: AgentSessionWriteNoticeSentence }
    }
  /** A start that failed: the sentence that failure has everywhere, whose next step is a send. */
  | { fact: AgentSessionFailureKind; action: AgentSessionRefusalAction }

function codeWords(action: AgentSessionRefusalAction): AgentSessionRefusalReasonWords {
  return { words: 'code', action }
}

function causeWords(
  cause: AgentSessionWriteNoticeSentence,
  action: AgentSessionRefusalAction,
  step?: AgentSessionWriteNoticeSentence
): AgentSessionRefusalReasonWords {
  return step ? { cause, step, action } : { cause, action }
}

const AGENT_STARTING = causeWords('agentStarting', 'wait', 'waitForStart')
const OWNER_UNPROVEN = causeWords('ownerUnproven', 'actFirst', 'reopenChat')
// Only a terminal agent an older build recorded holds a claim; quitting it frees the chat.
const TERMINAL_CLAIM = causeWords('terminalAgentHoldsChat', 'actFirst', 'quitTerminalAgent')

// Every reason of every code, so a reason the host adds does not compile until it has words.
// Reasons only a create, attach, hold or adopted import meets never reach a chat write; they keep
// their code's words.
const REASON_WORDS = {
  agent_session_operation_invalid: {
    requestMalformed: codeWords('hostFinding'),
    operationIdInvalid: codeWords('hostFinding'),
    messageIdReused: codeWords('hostFinding'),
    // Settled under that id, so the control's retry goes out under a new one.
    operationRefusedEarlier: codeWords('retry'),
    journalWriteFailed: causeWords('recordFailed', 'retry'),
    attachmentExpired: causeWords('attachmentExpired', 'actFirst', 'reattachFile'),
    conversationCleared: causeWords(
      'conversationCleared',
      'goElsewhere',
      'openCurrentConversation'
    ),
    // Only an older host sends this, and it keeps refusing the chat, so only a new chat continues.
    clearUnconfirmed: causeWords('clearUnfinished', 'goElsewhere', 'startNewChat'),
    // Only an older host sends this, for a /clear it never settled; only that host resolves it.
    conversationCommandUnconfirmed: codeWords('hostFinding'),
    conversationCommandInFlight: causeWords('commandRunning', 'wait', 'waitForCommand'),
    // The chat's agent process is being replaced, which a start or restart does.
    handoffInFlight: AGENT_STARTING,
    turnActive: causeWords('turnActive', 'wait', 'waitForTurn'),
    promptPending: causeWords('promptPending', 'actFirst', 'answerFirst'),
    backgroundTasksRunning: causeWords('backgroundTasksRunning', 'wait', 'waitForBackgroundTasks'),
    messagesUnsettled: causeWords('messagesUnsettled', 'actFirst', 'settleEarlierMessage'),
    // The rewind control words its own refusals; anywhere else says only that it did not happen.
    rewindRefused: codeWords('hostFinding'),
    rewindUnconfirmed: codeWords('hostFinding'),
    promptGone: causeWords('questionChanged', 'nothingLeft'),
    optionRejected: causeWords('optionRejected', 'retry'),
    providerStarting: AGENT_STARTING,
    goalsUnsupported: causeWords('goalsUnsupported', 'hostFinding'),
    providerRejected: causeWords('agentRefused', 'retry'),
    providerStartFailed: { fact: 'providerStartFailed', action: 'retry' },
    notSignedIn: { fact: 'notSignedIn', action: 'actFirst' },
    cliMissing: { fact: 'cliMissing', action: 'actFirst' },
    historyTooLarge: { fact: 'historyTooLarge', action: 'goElsewhere' },
    managedAccountEnvOverride: { fact: 'managedAccountEnvOverride', action: 'actFirst' },
    accountSwitchInProgress: { fact: 'accountSwitchInProgress', action: 'wait' },
    managedAccountUnsupported: { fact: 'managedAccountUnsupported', action: 'actFirst' },
    launchFolderMissing: { fact: 'launchFolderMissing', action: 'actFirst' },
    historyInOtherAccount: { fact: 'historyInOtherAccount', action: 'actFirst' },
    claudeAccountFolderMissing: { fact: 'claudeAccountFolderMissing', action: 'actFirst' },
    claudeAccountSetupFailed: { fact: 'claudeAccountSetupFailed', action: 'retry' },
    agentCommandNotRunnable: { fact: 'agentCommandNotRunnable', action: 'actFirst' },
    attachFailed: codeWords('retry')
  },
  agent_session_ownership_unknown: {
    sessionNotAttached: codeWords('retry'),
    noLiveOwner: codeWords('retry'),
    ownerUnproven: OWNER_UNPROVEN,
    claimConflicted: TERMINAL_CLAIM,
    recordMissing: codeWords('retry'),
    replaySuperseded: codeWords('retry'),
    leaseMoved: codeWords('retry'),
    spawnIdentityMismatch: codeWords('hostFinding'),
    notResumable: codeWords('retry'),
    noProviderChild: codeWords('retry'),
    conversationHeldElsewhere: codeWords('retry'),
    // Trying again retries the stop that could not prove the exit.
    previousExitUnverifiable: causeWords('ownerUnproven', 'retry')
  },
  agent_session_conflict: {
    chatStarting: AGENT_STARTING,
    ownerUnproven: OWNER_UNPROVEN,
    claimConflicted: TERMINAL_CLAIM,
    ownerAlive: codeWords('retry'),
    identityMismatch: codeWords('hostFinding'),
    sessionExists: codeWords('retry'),
    conversationHeldElsewhere: codeWords('retry'),
    tabIdTaken: codeWords('retry')
  },
  execution_owner_reconciling: {
    hostReconciling: causeWords('hostReconciling', 'wait', 'waitMoment'),
    recordUnreadable: causeWords('recordUnreadable', 'hostFinding')
  },
  agent_session_checkpoint_stale: {
    fenceStale: codeWords('retry'),
    leaseMoved: codeWords('retry'),
    recordMissing: codeWords('retry')
  },
  agent_session_identity_required: {
    recordMissing: causeWords('chatNotFound', 'goElsewhere', 'startNewChat'),
    transcriptNotFound: codeWords('retry'),
    transcriptUnreadable: codeWords('hostFinding')
  },
  agent_session_operation_conflict: {
    fingerprintMismatch: codeWords('hostFinding'),
    operationIdReused: codeWords('hostFinding'),
    handoffInFlight: codeWords('retry')
  },
  agent_session_operation_expired: { operationExpired: codeWords('retry') },
  agent_session_operation_capacity: { operationCapacity: codeWords('wait') },
  agent_session_operation_unknown: {
    outcomeUnknown: codeWords('checkChat'),
    resultLost: codeWords('checkChat'),
    rewindUnconfirmed: codeWords('checkChat'),
    tabUnconfirmed: codeWords('checkChat')
  },
  agent_session_item_revision_stale: { promptMoved: codeWords('nothingLeft') },
  agent_session_already_resolved: { promptAlreadyResolved: codeWords('nothingLeft') },
  agent_session_journal_unreadable: {
    // No retry reads past damage, and the words name no step: it only can't load.
    journalCorrupt: causeWords('historyUnusable', 'hostFinding'),
    // Says its step despite 'retry' unless a Retry stands beside it: the phone often has none.
    journalUnavailable: causeWords('historyUnavailable', 'retry', 'tryAgain'),
    // A write meets it on a newer Orca's database, or from an older host keeping the chat
    // read-only; a read meets it on this one chat, which only an update opens.
    journalWrittenByNewerOrca: {
      ...causeWords('savedByNewerOrca', 'updateOrca', 'updateOrcaToKeepUsing'),
      history: { cause: 'chatSavedByNewerOrca', step: 'updateOrcaToOpenChat' }
    }
  },
  // Mostly thrown as an RPC error; `hostUnsupported` is also returned and recorded. The code's own
  // words ask for an update, which only a method the host doesn't know proves; no reason here means
  // an older Orca. An unsupported location or agent, or no chat host, is not fixed by updating, and
  // a client missing the capability words this with its own older copy. Only `hostUnsupported`
  // names its cause: this agent or location can't run as a chat.
  structured_agent_session_unsupported: {
    clientCapabilityMissing: causeWords('notAvailable', 'hostFinding'),
    hostDisabled: causeWords('notAvailable', 'hostFinding'),
    hostUnsupported: causeWords('cannotRunHere', 'hostFinding')
  },
  agent_session_owner_restart_failed: {}
} satisfies {
  [C in AgentSessionWireRefusalCode]: Record<
    AgentSessionRefusalReason<C>,
    AgentSessionRefusalReasonWords
  >
}

/** The words and next step a reason gets; undefined when the refusal names none. */
export function agentSessionRefusalReasonWords(
  failure: AgentSessionWriteRefusal
): AgentSessionRefusalReasonWords | undefined {
  const reason = failure.details?.reason
  const byReason: Partial<Record<string, AgentSessionRefusalReasonWords>> | undefined =
    REASON_WORDS[failure.code]
  return reason === undefined ? undefined : byReason?.[reason]
}
