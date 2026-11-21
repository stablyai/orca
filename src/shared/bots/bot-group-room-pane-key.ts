// A group's room as a notification's pane: the push carries only worktree and pane strings.
const PREFIX = 'bot-group-room:'

export function botGroupRoomPaneKey(groupId: string): string {
  return `${PREFIX}${groupId}`
}

export function botGroupIdOfRoomPaneKey(paneKey: string | null | undefined): string | null {
  return paneKey?.startsWith(PREFIX) && paneKey.length > PREFIX.length
    ? paneKey.slice(PREFIX.length)
    : null
}
