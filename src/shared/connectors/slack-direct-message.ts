import { slackPlaceOf } from './slack-mirror-state'

/** Whether a conversation is a Slack direct message with the bot. The cloud names a DM by its
 *  channel twice (`T:D…:D…:UBOT`), and a thread by its ts (`T:C:ts:UBOT`), from where the message
 *  came, never from what anyone wrote in it. Another source's ids never read as Slack's. */
export function isSlackDirectMessage(conversation: {
  source: string
  externalId: string
}): boolean {
  if (conversation.source !== 'slack') {
    return false
  }
  const place = slackPlaceOf(conversation.externalId)
  return place !== null && place.threadTs === null && place.channelId.startsWith('D')
}
