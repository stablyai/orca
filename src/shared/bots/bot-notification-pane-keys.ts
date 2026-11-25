// Bot places a notification opens: the push carries only worktree and pane strings.
const ROOM_PREFIX = 'bot-group-room:'
const ITEM_PREFIX = 'bot-item:'

function afterPrefix(paneKey: string | null | undefined, prefix: string): string | null {
  return paneKey?.startsWith(prefix) && paneKey.length > prefix.length
    ? paneKey.slice(prefix.length)
    : null
}

export function botGroupRoomPaneKey(groupId: string): string {
  return `${ROOM_PREFIX}${groupId}`
}

export function botGroupIdOfRoomPaneKey(paneKey: string | null | undefined): string | null {
  return afterPrefix(paneKey, ROOM_PREFIX)
}

/** An item's page in the bot's panel, opened over its home. */
export function botItemPaneKey(itemUid: string): string {
  return `${ITEM_PREFIX}${itemUid}`
}

export function botItemUidOfPaneKey(paneKey: string | null | undefined): string | null {
  return afterPrefix(paneKey, ITEM_PREFIX)
}
