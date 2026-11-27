const PREFIX = 'bot-remote-group-'

/** Background conversations owned by a room on a paired computer, never private bot chats. */
export function isRemoteBotGroupSession(sessionId: string): boolean {
  return sessionId.startsWith(PREFIX)
}

export const REMOTE_BOT_GROUP_SESSION_PREFIX = PREFIX
