// The sentences a chat notice is made of, each whole so desktop can translate it on its own.

import type { AgentSessionFailureFact } from './agent-session-failure'
import {
  QUIT_TERMINAL_AGENT,
  START_NEW_CHAT,
  TERMINAL_AGENT_HOLDS_CHAT
} from './agent-session-failure-copy'
import type {
  AgentSessionFailureSurface,
  AgentSessionFailureWordsContext
} from './agent-session-failure-words'
import type { AgentSessionWriteKind } from './agent-session-write-failure'

/** Every sentence a notice is made of. Desktop translates each whole sentence with this as its
 *  fallback; mobile shows it as is. */
export const AGENT_SESSION_WRITE_NOTICE_COPY = {
  notDoneReadHistory: "This chat's history couldn't be loaded.",
  notDoneSend: 'Your message was not sent.',
  tryAgainComposerSend: 'Send it again.',
  messageNotSaved: "Couldn't save your message.",
  notDoneStop: "The agent wasn't stopped.",
  notDoneStopTask: "The background task wasn't stopped.",
  notDoneStopTasks: "The background tasks weren't stopped.",
  notDoneAnswer: 'Your answer was not sent.',
  notDoneOption: "The setting wasn't changed.",
  notDoneCommand: "The command didn't run.",
  notDoneGoal: "The goal wasn't changed.",
  restartFailed: "The agent couldn't restart.",
  capacity: 'Orca has received too many requests in the last day.',
  outcomeUnknown: "Orca couldn't confirm what happened. Check the chat.",
  sendOutcomeLost:
    "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed.",
  questionChanged: 'This question was already answered or has changed.',
  historyUnreadable: "Orca couldn't read this chat's saved history.",
  historyUnusable: 'Unable to load this chat.',
  historyUnavailable: "Orca couldn't open this chat's history right now.",
  savedByNewerOrca: 'Chats were saved by a newer Orca.',
  updateOrcaToKeepUsing: 'Update Orca to keep using them.',
  chatSavedByNewerOrca: 'This chat was saved by a newer Orca.',
  updateOrcaToOpenChat: 'Update Orca to open it.',
  unsupported:
    'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.',
  notAvailable: "This isn't available in this chat.",
  cannotRunHere: "Orca can't run this agent in a chat here.",
  unreachable: "Orca couldn't reach the agent.",
  recordFailed: "Orca couldn't save this to the chat's history.",
  attachmentExpired: 'This attachment expired.',
  reattachFile: 'Remove it and attach it again.',
  conversationCleared: 'This conversation has been cleared.',
  openCurrentConversation: 'Open the current conversation to continue.',
  clearUnfinished: "The last /clear didn't finish.",
  commandRunning: 'A /compact or /clear is still running.',
  waitForCommand: 'Wait for the /compact or /clear to finish.',
  agentStarting: 'The agent is still starting.',
  waitForStart: 'Wait for the agent to finish starting.',
  turnActive: 'The agent is still responding.',
  waitForTurn: 'Wait for the agent to finish responding, or stop it.',
  promptPending: 'The agent is waiting for an answer to a question or approval.',
  answerFirst: 'Answer the question or approval first.',
  backgroundTasksRunning: 'Background tasks are still running.',
  waitForBackgroundTasks: 'Wait for the background tasks to finish.',
  messagesUnsettled: "A message you sent earlier isn't confirmed yet.",
  settleEarlierMessage: 'Wait for your earlier message to go through, or retry it.',
  optionRejected: "The agent didn't accept this setting.",
  goalsUnsupported: "This agent doesn't support goals.",
  agentRefused: 'The agent turned this down.',
  ownerUnproven: 'The previous agent in this chat may still be running.',
  reopenChat: 'Reopen the chat to check again.',
  terminalAgentHoldsChat: TERMINAL_AGENT_HOLDS_CHAT,
  quitTerminalAgent: QUIT_TERMINAL_AGENT,
  hostReconciling: 'Orca is still checking on this chat after restarting.',
  waitMoment: 'Wait a moment.',
  recordUnreadable: "Orca couldn't read this chat's saved state.",
  chatNotFound: "Orca can't find this chat.",
  startNewChat: START_NEW_CHAT,
  tryAgain: 'Try again.'
} as const

/** Not fixed sentences: each names the time, read from the refusal when it is shown. The return
 *  can be up to a day away, so a bare clock time could read as one already past today. */
export const AGENT_SESSION_CAPACITY_RETURNS_COPY = {
  capacityReturnsAt: 'Orca can take new requests again at {{time}}.',
  capacityReturnsTomorrowAt: 'Orca can take new requests again tomorrow at {{time}}.',
  capacityReturnsOnDayAt: 'Orca can take new requests again on {{day}} at {{time}}.'
} as const

export type AgentSessionCapacityReturnsSentence = keyof typeof AGENT_SESSION_CAPACITY_RETURNS_COPY

function localDayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}

/** Rounded up, so the minute shown is never before a request would be admitted; the day is named
 *  whenever it is not the reader's today. */
export function agentSessionCapacityReturns(at: number): {
  sentence: AgentSessionCapacityReturnsSentence
  time: string
  day: string
} {
  const minute = 60_000
  const shown = new Date(Math.ceil(at / minute) * minute)
  const time = shown.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = localDayNumber(shown) - localDayNumber(new Date())
  const day = shown.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  })
  return {
    sentence:
      days === 0
        ? 'capacityReturnsAt'
        : days === 1
          ? 'capacityReturnsTomorrowAt'
          : 'capacityReturnsOnDayAt',
    time,
    day
  }
}

export function agentSessionCapacityReturnsEnglish(at: number): string {
  const { sentence, time, day } = agentSessionCapacityReturns(at)
  return AGENT_SESSION_CAPACITY_RETURNS_COPY[sentence]
    .replace('{{day}}', day)
    .replace('{{time}}', time)
}

export type AgentSessionWriteNoticeSentence = keyof typeof AGENT_SESSION_WRITE_NOTICE_COPY

/** That the write did not happen, by what was being written. */
export const AGENT_SESSION_WRITE_NOT_DONE: Record<
  AgentSessionWriteKind,
  AgentSessionWriteNoticeSentence
> = {
  'read-history': 'notDoneReadHistory',
  send: 'notDoneSend',
  'composer-send': 'notDoneSend',
  stop: 'notDoneStop',
  'stop-task': 'notDoneStopTask',
  'stop-tasks': 'notDoneStopTasks',
  answer: 'notDoneAnswer',
  option: 'notDoneOption',
  command: 'notDoneCommand',
  goal: 'notDoneGoal'
}

/** A failure fact, worded where it is shown so desktop can say it in the reader's language. */
export type AgentSessionWriteNoticeFailurePart = {
  failure: AgentSessionFailureFact
  surface: AgentSessionFailureSurface
  context: AgentSessionFailureWordsContext
}
/** A notice as whole sentences, each translated on its own; `text` is words someone else wrote: a
 *  provider's, or a host's sentence with no fact beside it. */
export type AgentSessionWriteNoticePart =
  | AgentSessionWriteNoticeSentence
  | { text: string }
  /** When a full operation ledger takes new requests again, in epoch ms. */
  | { capacityReturnsAt: number }
  | AgentSessionWriteNoticeFailurePart

/** Causes that already say the history can't be read here, so no sentence after them says it
 *  again. */
export const AGENT_SESSION_HISTORY_UNREAD_CAUSES: ReadonlySet<AgentSessionWriteNoticeSentence> =
  new Set([
    'historyUnusable',
    'historyUnavailable',
    'historyUnreadable',
    'savedByNewerOrca',
    'chatSavedByNewerOrca'
  ])
