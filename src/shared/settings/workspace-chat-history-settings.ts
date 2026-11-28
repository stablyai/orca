/** What workspace cleanup deletes once a workspace's folder is gone. Absent means off for each. */
export type WorkspaceChatHistorySettings = {
  /** Orca's own chats; seeded on only for new profiles, so existing users keep their choice. */
  deleteOrcaChatsWithWorkspace?: boolean
  /** Claude Code and Codex transcripts. */
  deleteAgentTranscriptsWithWorkspace?: boolean
  /** The older combined switch, which older builds and hosts read: kept true only while both are on. */
  deleteChatHistoryWithWorkspace?: boolean
}

/**
 * The writes one settings update implies: an older client's combined switch sets both parts, and
 * the combined switch always mirrors "both on", so an older build never deletes what one part keeps.
 */
export function chatHistoryDeletionUpdates(
  current: WorkspaceChatHistorySettings,
  updates: WorkspaceChatHistorySettings
): WorkspaceChatHistorySettings {
  const legacy = 'deleteChatHistoryWithWorkspace' in updates
  if (
    !legacy &&
    !('deleteOrcaChatsWithWorkspace' in updates) &&
    !('deleteAgentTranscriptsWithWorkspace' in updates)
  ) {
    return {}
  }
  const both = legacy ? updates.deleteChatHistoryWithWorkspace === true : undefined
  const orca =
    both ?? (updates.deleteOrcaChatsWithWorkspace ?? current.deleteOrcaChatsWithWorkspace) === true
  const transcripts =
    both ??
    (updates.deleteAgentTranscriptsWithWorkspace ?? current.deleteAgentTranscriptsWithWorkspace) ===
      true
  return {
    deleteOrcaChatsWithWorkspace: orca,
    deleteAgentTranscriptsWithWorkspace: transcripts,
    deleteChatHistoryWithWorkspace: orca && transcripts
  }
}
