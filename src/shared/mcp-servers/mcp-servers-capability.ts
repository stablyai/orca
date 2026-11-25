// The host serves mcpServers.* (Settings › MCP servers, the phone's page, the bot Tools switch).
// An older host doesn't advertise it, so clients hide the feature there.
export const MCP_SERVERS_RUNTIME_CAPABILITY = 'mcp-servers.v1' as const
