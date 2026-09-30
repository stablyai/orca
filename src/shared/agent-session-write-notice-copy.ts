// The sentences a chat notice is made of, each whole so desktop can translate it on its own.

import {
  QUIT_TERMINAL_AGENT,
  START_NEW_CHAT,
  TERMINAL_AGENT_HOLDS_CHAT
} from './agent-session-failure-words'

/** Every sentence a notice is made of. Desktop translates each whole sentence with this as its
 *  fallback; mobile shows it as is. */
export const AGENT_SESSION_WRITE_NOTICE_COPY = {
  notDoneReadHistory: "This chat's history couldn't be loaded.",
  notDoneSend: 'Your message was not sent.',
  tryAgainComposerSend: 'Send it again.',
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
  questionChanged: 'This question was already answered or has changed.',
  historyUnreadable: "Orca couldn't read this chat's saved history.",
  historyUnusable: 'Unable to load this chat.',
  historyUnavailable: "Orca couldn't open this chat's history right now.",
  savedByNewerOrca: 'Chats were saved by a newer Orca.',
  updateOrcaToKeepUsing: 'Update Orca to keep using them.',
  unsupported: "The Orca running this chat doesn't support this. Update Orca, then try again.",
  unreachable: "Orca couldn't reach the agent.",
  recordFailed: "Orca couldn't record it in this chat's history.",
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
  messagesUnsettled: "A message you sent earlier hasn't been confirmed yet.",
  settleEarlierMessage: 'Wait for your earlier message to go through, or retry it.',
  optionRejected: "The agent didn't accept this setting.",
  goalsUnsupported: "This agent doesn't support goals.",
  agentRefused: 'The agent turned this down.',
  ownerUnproven: "Orca hasn't confirmed that this chat's previous agent stopped.",
  reopenChat: 'Reopen the chat to check again.',
  terminalAgentHoldsChat: TERMINAL_AGENT_HOLDS_CHAT,
  quitTerminalAgent: QUIT_TERMINAL_AGENT,
  hostReconciling: 'Orca is still checking on this chat after restarting.',
  waitMoment: 'Wait a moment.',
  recordUnreadable: "Orca couldn't read this chat's saved state.",
  chatNotFound: 'The Orca running this chat has no record of it.',
  startNewChat: START_NEW_CHAT,
  tryAgain: 'Try again.'
} as const

export type AgentSessionWriteNoticeSentence = keyof typeof AGENT_SESSION_WRITE_NOTICE_COPY
/** A notice as whole sentences, each translated on its own; `text` is a provider's own words. */
export type AgentSessionWriteNoticePart = AgentSessionWriteNoticeSentence | { text: string }
