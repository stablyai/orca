// orca-fork: rodrillet/orca feature switches; upstream never edits this file, so merges keep it.

export const FORK_REPOSITORY = 'rodrillet/orca'

export const FORK_FEATURES = {
  /** Upstream's updater would replace the custom build (and a paired fork server) with a stock one. */
  upstreamUpdater: false,
  /** A bot's chat rows in the sidebar show their last message under the title, as agentes.chat's. */
  sidebarChatPreviews: true,
  /** A bot's row counts its unread chats. */
  sidebarUnreadChatCount: true,
  /** "Change photo…" in a bot's row menu. */
  sidebarChangePhoto: true,
  /** Phase 4: a bot the owner lets build a team creates bots from its own offers. */
  agentTeams: true
} as const
