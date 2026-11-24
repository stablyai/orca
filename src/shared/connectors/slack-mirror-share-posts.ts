// A shared teammate's Slack-started chat posting their own Orca messages back to its thread.
import {
  shareTypistOf,
  type AgentJournalTypedBy
} from '../agent-session/journal/agent-journal-typed-by'
import { shareOwnsChat, type BotRequestAsker } from '../bots/bot-acts-for'

/** Whether a shared teammate's own Orca message in their own Slack-started chat posts as a
 *  default-on chat's would, though the chat starts off for the owner (slackMirrorDefault): unless
 *  the bot's setting is off. A chat that also acts for anyone else is not theirs. */
export function slackMirrorPostsShare(
  typedBy: AgentJournalTypedBy | undefined,
  chatActsFor: readonly BotRequestAsker[] | undefined,
  botSetting: boolean | undefined
): boolean {
  const typist = shareTypistOf(typedBy)
  return (
    typist !== undefined &&
    chatActsFor !== undefined &&
    shareOwnsChat(chatActsFor, typist.accountId) &&
    botSetting !== false
  )
}
