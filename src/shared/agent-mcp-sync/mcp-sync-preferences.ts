export const CLOUD_MCP_SYNC_CHANGED_CHANNEL = 'cloudMcpSync:changed'

export type CloudMcpSyncPreferences = {
  /** Sync on every connect to an Orca Cloud workspace. */
  autoSync: boolean
  /** `agent:name` keys the user turned off. */
  excluded: string[]
}
