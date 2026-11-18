import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  findBotGroupRoomOfSession,
  isBotGroupMemberSession,
  type BotGroup
} from '../../../shared/bots/bot-group'
import { botGroupRoomLabel } from './bot-group-room-label'

/** The group room a history row's native session belongs to, if it is a current member's. */
export function botGroupRoomOfRow(
  groups: readonly BotGroup[],
  session: Pick<AiVaultSession, 'structuredSession'>
): { group: BotGroup; roomId: string; label: string } | null {
  const sessionId = session.structuredSession?.sessionId
  const found =
    sessionId && isBotGroupMemberSession(sessionId)
      ? findBotGroupRoomOfSession(groups, sessionId)
      : null
  return found
    ? {
        group: found.group,
        roomId: found.threadId ?? found.group.id,
        label: botGroupRoomLabel(found.group, found.threadId)
      }
    : null
}

/** A room's member rows belong where the room lives, the group's home, so a workspace-scoped
 *  history there lists them; a member's other sessions stay in the bot's own home. */
export function placeBotGroupRoomRows<T extends Pick<AiVaultSession, 'structuredSession' | 'cwd'>>(
  sessions: readonly T[],
  groups: readonly BotGroup[],
  homePathOf: (folderWorkspaceId: string) => string | null
): readonly T[] {
  if (groups.length === 0) {
    return sessions
  }
  let moved = false
  const placed = sessions.map((session) => {
    const room = botGroupRoomOfRow(groups, session)
    const home = room ? homePathOf(room.group.folderWorkspaceId) : null
    if (!home || session.cwd === home) {
      return session
    }
    moved = true
    return { ...session, cwd: home, cwdAliases: undefined }
  })
  return moved ? placed : sessions
}

/** Each group room lists once in Session History: its members' rows fold into the newest. */
export function collapseBotGroupRoomRows<
  T extends Pick<AiVaultSession, 'structuredSession' | 'modifiedAt'>
>(sessions: readonly T[], groups: readonly BotGroup[]): readonly T[] {
  if (groups.length === 0) {
    return sessions
  }
  const newest = new Map<string, T>()
  for (const session of sessions) {
    const room = botGroupRoomOfRow(groups, session)
    const kept = room ? newest.get(room.roomId) : undefined
    if (room && (!kept || Date.parse(session.modifiedAt) > Date.parse(kept.modifiedAt))) {
      newest.set(room.roomId, session)
    }
  }
  if (newest.size === 0) {
    return sessions
  }
  const shown = new Set(newest.values())
  return sessions.filter((session) => !botGroupRoomOfRow(groups, session) || shown.has(session))
}
