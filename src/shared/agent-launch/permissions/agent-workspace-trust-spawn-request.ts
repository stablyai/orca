/** Optional fresh-launch pretrust: the relay derives the preset from launchAgent and writes its own disk. Older relays ignore it, leaving the agent to ask. */
export type AgentWorkspaceTrustSpawnRequest = {
  workspacePath: string
}
