// A room tab shows its members' sessions; each one's attention is keyed by the tab it stands in for.
import { botGroupRoom, findBotGroupRoom } from '../../../shared/bots/bot-group'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { readBotGroups } from './bot-group-catalog-snapshot'

export type BotGroupRoomSession = { id: string; sessionId: string }

/** The member sessions a room tab (whose entity is the room's id) shows, by their stand-in tab ids. */
export function botGroupRoomSessions(roomId: string): BotGroupRoomSession[] {
  const place = findBotGroupRoom(readBotGroups(), roomId)
  if (!place) {
    return []
  }
  return botGroupRoom(place.group, place.threadId).members.map(({ sessionId }) => ({
    id: structuredAgentSessionTabId(sessionId),
    sessionId
  }))
}
