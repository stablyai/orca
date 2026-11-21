// Mail for a group's remote members comes home to the room, never to an agent's mailbox.

const BOT_GROUP_ROOM_MAIL_PREFIX = 'bot-group-room:'

/** The address a group's remote members answer to on this computer: the room, never an agent. */
export function botGroupRoomMailAddress(groupId: string): string {
  return `${BOT_GROUP_ROOM_MAIL_PREFIX}${groupId}`
}

/** The group a room mail address names; null for any other address. */
export function botGroupOfRoomMailAddress(handle: string): string | null {
  return handle.startsWith(BOT_GROUP_ROOM_MAIL_PREFIX)
    ? handle.slice(BOT_GROUP_ROOM_MAIL_PREFIX.length) || null
    : null
}
