import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  isFolder: boolean
  isFolderWorkspace: boolean
  /** The workspace runs on an SSH host (directly or through its managed server) or a paired server. */
  hasRemoteHost: boolean
  /** The workspace is a bot's home, whose page keeps only its own panels. */
  isBot: boolean
  /** The workspace is a bot group's home: members' workers attach to each bot's own home, so its folder panels are always empty. */
  isGroupHome?: boolean
  /** The focused native chat has started orchestration workers, which the Activity panel lists. */
  hasChatWorkers?: boolean
  isPerforce?: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  {
    isFolder,
    isFolderWorkspace,
    hasRemoteHost,
    isBot,
    isGroupHome = false,
    hasChatWorkers = false,
    isPerforce = false
  }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  if (isGroupHome) {
    // A group's page keeps its Items; its folder panels are always empty.
    return items.filter((item) => item.botOnly)
  }
  if (isBot) {
    // A bot's own tabs lead; Files comes last.
    return [
      ...items.filter((item) => item.botOnly || item.botPageOnly),
      ...items.filter((item) => item.onBotPage)
    ]
  }
  return items.filter(
    (item) =>
      !item.botPageOnly &&
      (item.botOnly
        ? hasChatWorkers
        : (!item.gitOnly ||
            !isFolder ||
            (item.perforceCapable === true && isPerforce) ||
            (isFolderWorkspace && !isGroupHome && item.id === 'source-control')) &&
          (!item.folderOnly || (isFolderWorkspace && !isGroupHome)) &&
          (!item.remoteHostOnly || hasRemoteHost))
  )
}
