import type { BotAgentSetup } from './bots/bot-agent-setup'

/** 'new': a new conversation in the bot's folder each run; 'chat': continue the bot's Chat, or the
 *  chat the target names. */
export type AutomationBotRunsIn = 'new' | 'chat'
/**
 * A channel goes through the bot's Slack app; a Linear issue through Orca's Linear app. channel and
 * linearIssue keep the id or key (C0123ABCD, ENG-123) older clients read and save back; where the
 * host's Orca Cloud takes refs, ref (slack:T1:C1, linear:<org>:<issueId>) is where it posts, and label
 * what people see. 'thread' answers in the Slack thread, pull request or issue the event happened on.
 */
type ResultPlace = { ref?: string; label?: string }
export type AutomationBotResultsTo =
  | 'chat'
  | ({ channel: string } & ResultPlace)
  | ({ linearIssue: string } & ResultPlace)
  | 'none'
  | 'thread'

/** The channel or Linear issue a result posts to, by its label where the host saved it as a ref. */
export function botResultsPlace(resultsTo: Extract<AutomationBotResultsTo, object>): string {
  return resultsTo.label ?? ('channel' in resultsTo ? resultsTo.channel : resultsTo.linearIssue)
}

/** The bot an automation runs as: its folder, agent and preamble replace the project target. */
export type AutomationBotTarget = {
  botId: string
  runsIn: AutomationBotRunsIn
  /** With runsIn 'chat': the one of the bot's chats runs continue instead of its Home Chat, and its
   *  title when saved. A run whose chat is gone fails rather than going to the Home Chat, unless
   *  homeIfGone: set when Orca chose the chat (a wait runs in the chat that made it), not a person.
   *  toConversation: that wait was made by a turn its chat's thread owns, so its run answers there. */
  chat?: { sessionId: string; title?: string; homeIfGone?: true; toConversation?: true }
  resultsTo: AutomationBotResultsTo
  /** Results to the bot's Chat start a turn, as a message the bot answers; off, they wait there as a
   *  note it reads with the person's next message. Older hosts drop it and always start one. */
  letBotReact?: boolean
  /** Its own agent and launch for runs in a new conversation; absent, the bot's. Kept when the bot
   *  switches agents, since a launch belongs to its agent. Older hosts drop it. */
  agentSetup?: BotAgentSetup
}
