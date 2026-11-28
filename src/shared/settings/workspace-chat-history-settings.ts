/** What workspace cleanup deletes once a workspace's folder is gone. Absent means off for both. */
export type WorkspaceChatHistorySettings = {
  /** Claude Code and Codex transcripts. */
  deleteChatHistoryWithWorkspace?: boolean
  /** Orca's own chats; seeded on only for new profiles, so existing users keep their choice. */
  deleteOrcaChatsWithWorkspace?: boolean
}
